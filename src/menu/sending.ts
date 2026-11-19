import { confirm, select, Separator } from '@inquirer/prompts';
import { getEnv } from '../config/env.ts';
import { connectGmail, disconnectGmail, gmailStatus, sendTestEmails } from '../controllers/sendController.ts';
import type { Db } from '../db/connection.ts';
import { openExternal } from '../lib/openExternal.ts';
import { DraftModel } from '../models/draftModel.ts';
import { SendModel } from '../models/sendModel.ts';
import { friendlyHooks } from '../views/friendlyHooks.ts';
import { bad, dim, info, keyValues, newPage, ok, table, title, warn } from '../views/ui.ts';
import { explainError, pause } from './prompts.ts';

/** Test sending: approved drafts go ONLY to the owner's TEST_RECIPIENT. */
export async function sendTestFlow(db: Db): Promise<void> {
  const env = getEnv();
  const status = gmailStatus();
  const sends = new SendModel(db);
  const approved = new DraftModel(db).list('approved', 10_000);
  const notYetSent = approved.filter((d) => !sends.lastSentForDraft(d.id));
  const left = Math.max(0, env.TEST_SEND_MAX_PER_DAY - sends.sentLast24h());

  console.log(title('Send test emails'));
  console.log(dim('  Approved drafts are sent ONLY to your own inbox, labelled TEST. No company receives anything.'));
  console.log(
    `\n${keyValues([
      ['Sent from', status.connectedAs ?? warn('Gmail not connected yet')],
      ['Delivered to', env.TEST_RECIPIENT ?? bad('TEST_RECIPIENT not set in .env')],
      ['Approved, not test-sent yet', String(notYetSent.length)],
      ['Test emails left today', `${left} of ${env.TEST_SEND_MAX_PER_DAY}`],
    ])}\n`,
  );

  if (!status.connectedAs) {
    if (!(await confirm({ message: 'Gmail is not connected. Connect it now?', default: true }))) return;
    await connectFlow();
  }
  if (approved.length === 0) {
    console.log(info('No approved drafts yet. Approve some under "Email drafts" first.'));
    await pause();
    return;
  }

  const choice = await select<string>({
    message: 'What do you want to send?',
    choices: [
      { name: 'Just one, to try it out', value: 'one', disabled: notYetSent.length ? false : '(all approved drafts were already test-sent)' },
      { name: `All approved drafts not test-sent yet (${Math.min(notYetSent.length, left)})`, value: 'all', disabled: notYetSent.length && left ? false : '(none)' },
      { name: 'Pick a specific draft (can resend)', value: 'pick' },
      new Separator(),
      { name: '← Back', value: 'back' },
    ],
  });
  if (choice === 'back') return;

  let input: { draftIds?: number[]; limit: number; resend?: boolean };
  if (choice === 'pick') {
    const id = await select<number | null>({
      message: 'Which draft?',
      pageSize: 15,
      choices: [
        { name: '← Back', value: null },
        ...approved.map((d) => ({ name: `#${d.id}  ${d.company_name ?? d.domain}${sends.lastSentForDraft(d.id) ? dim(' (already test-sent)') : ''}`, value: d.id })),
      ],
    });
    if (id === null) return;
    input = { draftIds: [id], limit: 1 };
  } else {
    input = { limit: choice === 'one' ? 1 : Math.min(100, Math.max(1, left)) };
  }
  if (!(await confirm({ message: `Send to ${env.TEST_RECIPIENT} now?`, default: true }))) return;

  const res = await sendTestEmails(db, input, friendlyHooks());
  console.log(
    `\n${ok(`${res.sent} test email(s) sent to ${env.TEST_RECIPIENT}.`)}${res.failed ? `\n${bad(`${res.failed} failed.`)}` : ''}${
      res.blocked ? `\n${warn(`${res.blocked} blocked by the checks (fix and approve again).`)}` : ''
    }\n${dim(`  ${res.remainingToday} test emails left today. Check your inbox (and Spam, the first time).`)}`,
  );
  await pause();
}

export async function connectFlow(): Promise<void> {
  const env = getEnv();
  console.log(info(`Your browser should open now. Sign in as ${env.EMAIL_FROM ?? '(EMAIL_FROM not set)'} and click Allow.`));
  console.log(dim('  The app only asks to SEND email. It cannot read your inbox.'));
  const email = await connectGmail((url) => {
    console.log(dim('\n  If the browser did not open, copy this whole link into your browser:'));
    console.log(`  ${url}\n`);
    console.log(dim('  Waiting for you to finish signing in (up to 5 minutes; Ctrl+C to cancel)...'));
    try {
      openExternal(url);
    } catch {
      /* the link is printed above */
    }
  });
  console.log(ok(`Gmail connected as ${email}.`));
}

export async function gmailFlow(db: Db): Promise<void> {
  for (;;) {
    newPage();
    const s = gmailStatus();
    console.log(title('Gmail (for test emails)'));
    console.log(
      `\n${keyValues([
        ['Sign-in file', s.clientFile ? ok('found') : bad('missing: data/google-oauth-client.json')],
        ['Connected as', s.connectedAs ?? dim('not connected')],
      ])}\n`,
    );
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: s.connectedAs ? 'Reconnect' : 'Connect Gmail', value: 'connect', disabled: s.clientFile ? false : '(sign-in file missing)' },
        { name: 'Disconnect', value: 'disconnect', disabled: s.connectedAs ? false : '(not connected)' },
        { name: 'Test email log', value: 'log' },
        new Separator(),
        { name: '← Back', value: 'back' },
      ],
    });
    if (action === 'back') return;
    try {
      if (action === 'connect') await connectFlow();
      if (action === 'disconnect') console.log(disconnectGmail() ? ok('Disconnected.') : info('Was not connected.'));
      if (action === 'log') {
        const rows = new SendModel(db).list(100);
        console.log(
          rows.length
            ? table(rows, [
                { header: 'When', get: (r) => r.created_at.slice(0, 16).replace('T', ' '), min: 16 },
                { header: 'Company', get: (r) => r.company_name ?? r.domain, flex: 2, min: 14 },
                { header: 'Result', get: (r) => (r.status === 'sent' ? ok('sent to you') : bad(r.status)), min: 14 },
                { header: 'Written for', get: (r) => r.intended_to, flex: 2, min: 14 },
              ])
            : info('No test emails sent yet.'),
        );
      }
    } catch (err) {
      console.log(explainError(err));
    }
    await pause();
  }
}
