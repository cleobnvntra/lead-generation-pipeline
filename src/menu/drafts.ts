import { confirm, editor, input, select, Separator } from '@inquirer/prompts';
import { getEnv } from '../config/env.ts';
import { approveDraft, checkDraft, editDraft, rejectDraft, resetDraft, writeDrafts } from '../controllers/draftController.ts';
import type { Db } from '../db/connection.ts';
import { DraftModel, MAX_SUBJECT } from '../models/draftModel.ts';
import { createLlmProvider } from '../services/llm/index.ts';
import { draftStatusBadge, renderDraft } from '../views/draftView.ts';
import { friendlyHooks } from '../views/friendlyHooks.ts';
import { bad, dim, info, keyValues, newPage, ok, table, title, warn } from '../views/ui.ts';
import { explainError, isExitPrompt, pause } from './prompts.ts';
import { sendTestFlow } from './sending.ts';

export async function draftsFlow(db: Db): Promise<void> {
  const model = new DraftModel(db);
  let flash: string | null = null;
  for (;;) {
    newPage(flash);
    flash = null;
    const waiting = model.listEligible(1000, false).length;
    const counts = model.counts();
    const toApprove = counts.draft ?? 0;
    const total = toApprove + (counts.approved ?? 0) + (counts.rejected ?? 0);
    console.log(title('Email drafts'));
    console.log(dim('  Drafts are written, checked and approved here. Nothing is sent.'));
    console.log(
      `\n${keyValues([
        ['Companies without a draft', String(waiting)],
        ['Waiting for approval', String(toApprove)],
        ['Approved', String(counts.approved ?? 0)],
        ['Rejected', String(counts.rejected ?? 0)],
      ])}\n`,
    );
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: `Approve drafts one by one${toApprove ? ` (${toApprove})` : ''}`, value: 'approve', disabled: toApprove ? false : '(none waiting)' },
        { name: `Write drafts for companies ready to email${waiting ? ` (${waiting})` : ''}`, value: 'write', disabled: waiting ? false : '(none waiting)' },
        { name: 'See all drafts', value: 'view', disabled: total ? false : '(none yet)' },
        { name: 'Send approved drafts as TEST emails (only to you)', value: 'send', disabled: counts.approved ? false : '(approve some first)' },
        { name: 'Rewrite drafts that are waiting (keeps ones you edited)', value: 'redo', disabled: toApprove ? false : '(none)' },
        new Separator(),
        { name: '← Back', value: 'back' },
      ],
    });
    if (action === 'back') return;
    if (action === 'approve') {
      flash = await approvalFlow(db);
      continue;
    }
    if (action === 'view') {
      await viewDraftsFlow(db);
      continue;
    }
    if (action === 'send') {
      newPage();
      try {
        await sendTestFlow(db);
      } catch (err) {
        if (isExitPrompt(err)) throw err;
        flash = explainError(err);
      }
      continue;
    }
    if (action === 'redo' && !(await confirm({ message: 'Rewrite drafts that are waiting for approval? Drafts you edited are kept.', default: false }))) continue;
    await writeDrafts(db, createLlmProvider(), { limit: 1000, redo: action === 'redo' }, friendlyHooks());
    console.log(`\n${info('Next: choose "Approve drafts one by one".')}`);
    await pause();
  }
}

/** Goes through every draft waiting for approval, one page each. Returns a summary message. */
async function approvalFlow(db: Db): Promise<string> {
  const ids = new DraftModel(db).list('draft', 1000).map((d) => d.id);
  let approved = 0;
  let rejected = 0;
  for (const [i, id] of ids.entries()) {
    const outcome = await draftScreen(db, id, `Draft ${i + 1} of ${ids.length}`);
    if (outcome === 'stop') break;
    if (outcome === 'approved') approved++;
    if (outcome === 'rejected') rejected++;
  }
  return ok(`Approved ${approved}, rejected ${rejected}. Approved drafts can be sent as tests once sending is set up.`);
}

type ScreenOutcome = 'approved' | 'rejected' | 'next' | 'stop';

/**
 * One draft with all actions. Used by the approval walk-through and by "See all drafts".
 * Returns when the draft is decided, skipped, or the user leaves.
 */
async function draftScreen(db: Db, id: number, heading?: string): Promise<ScreenOutcome> {
  let flash: string | null = null;
  for (;;) {
    newPage(flash);
    flash = null;
    const check = checkDraft(db, id);
    const d = new DraftModel(db).list(undefined, 10_000).find((x) => x.id === id)!;
    if (heading) console.log(info(heading));
    console.log(renderDraft(d, getEnv().TEST_RECIPIENT));
    for (const p of check.problems) console.log(bad(`Can't approve yet: ${p}`));
    if (d.status === 'draft') for (const w of check.warnings) console.log(dim(`  Note: ${w}`));

    const choices =
      d.status === 'draft'
        ? [
            { name: 'Approve', value: 'approve', disabled: check.problems.length ? '(fix the problems above first)' : false },
            { name: 'Edit the subject', value: 'subject' },
            { name: 'Edit the email text (opens Notepad)', value: 'body' },
            { name: 'Reject — don’t send this one', value: 'reject' },
            { name: heading ? 'Skip for now' : '← Back', value: 'next' },
          ]
        : [
            { name: d.status === 'approved' ? 'Undo approval' : 'Undo rejection', value: 'reset' },
            ...(d.status === 'approved' ? [{ name: 'Edit (it will need approval again)', value: 'body' }] : []),
            { name: heading ? 'Next' : '← Back', value: 'next' },
          ];
    const action = await select({
      message: 'What would you like to do?',
      choices: [...choices, ...(heading ? [new Separator(), { name: '← Stop', value: 'stop' }] : [])],
    });

    try {
      if (action === 'next' || action === 'stop') return action;
      if (action === 'approve') {
        approveDraft(db, id); // throws with the reasons if any rule fails
        if (heading) return 'approved';
        flash = ok('Approved.');
      }
      if (action === 'reject') {
        const reason = await input({
          message: 'Why? (press Enter to keep)',
          default: 'Not a good fit',
          validate: (v) => (v.trim().length >= 3 && v.trim().length <= 300) || 'Please write 3-300 characters',
        });
        rejectDraft(db, id, reason);
        if (heading) return 'rejected';
        flash = ok('Rejected.');
      }
      if (action === 'reset') {
        resetDraft(db, id);
        flash = ok('Back to "waiting for approval".');
      }
      if (action === 'subject') {
        const subject = await input({
          message: 'New subject:',
          default: d.subject,
          validate: (v) => (v.trim().length >= 3 && v.trim().length <= MAX_SUBJECT) || `Please write 3-${MAX_SUBJECT} characters`,
        });
        flash = afterEdit(editDraft(db, id, subject, d.body));
      }
      if (action === 'body') {
        console.log(dim('\n  Notepad will open. Edit the text, save (Ctrl+S), then close Notepad to come back here.'));
        const body = await editor({ message: 'Editing in Notepad…', default: d.body, postfix: '.txt', waitForUserInput: false });
        flash = afterEdit(editDraft(db, id, d.subject, body));
      }
    } catch (err) {
      flash = explainError(err);
    }
  }
}

function afterEdit(res: { problems: string[]; draft: { edited: 0 | 1 } }): string {
  if (res.problems.length) return warn(`Saved, but it can't be approved until fixed:\n${res.problems.map((p) => `    - ${p}`).join('\n')}`);
  return ok('Saved your changes.');
}

export async function viewDraftsFlow(db: Db): Promise<void> {
  const model = new DraftModel(db);
  for (;;) {
    newPage();
    const rows = model.list(undefined, 500);
    console.log(title(`${rows.length} email draft${rows.length === 1 ? '' : 's'}`));
    console.log(
      table(rows, [
        { header: '#', get: (r) => String(r.id), min: 4 },
        { header: 'Company', get: (r) => r.company_name ?? r.domain, flex: 2, min: 14 },
        { header: 'Subject', get: (r) => `${r.subject}${r.edited ? dim(' (edited)') : ''}`, flex: 3, min: 20 },
        { header: 'Status', get: (r) => draftStatusBadge(r), min: 22 },
      ]),
    );
    const id = await select<number | null>({
      message: 'Open a draft?',
      pageSize: 15,
      choices: [{ name: '← Back', value: null }, ...rows.map((r) => ({ name: `#${r.id}  ${r.company_name ?? r.domain}`, value: r.id }))],
    });
    if (id === null) return;
    await draftScreen(db, id);
  }
}

/** Opens one draft (used from a company's page). */
export async function showDraft(db: Db, id: number): Promise<void> {
  await draftScreen(db, id);
}
