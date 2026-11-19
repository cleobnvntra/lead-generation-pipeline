import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { getBrand, type Brand } from '../config/brand.ts';
import { getEnv, type Env } from '../config/env.ts';
import type { Db } from '../db/connection.ts';
import { ConfigError, LimitError, ValidationError } from '../lib/errors.ts';
import { openExternal } from '../lib/openExternal.ts';
import { logHooks, type ProgressHooks } from '../lib/progress.ts';
import { DraftModel, type Draft } from '../models/draftModel.ts';
import { SendModel } from '../models/sendModel.ts';
import { gmailSendRaw } from '../services/gmail/gmailClient.ts';
import { buildPlainTextMessage } from '../services/gmail/mime.ts';
import { deleteToken, getAccessToken, loadOAuthClient, loadToken, signIn } from '../services/gmail/oauth.ts';
import { checkDraft } from './draftController.ts';

const SEND_SPACING_MS = 3000;

function paths(env: Env) {
  return { client: join(env.DATA_DIR, 'google-oauth-client.json'), token: join(env.DATA_DIR, 'google-token.json') };
}

function requireSender(env: Env): { from: string; testTo: string } {
  if (!env.EMAIL_FROM) throw new ConfigError('EMAIL_FROM is not set in .env (the account emails are sent from).');
  if (!env.TEST_RECIPIENT) throw new ConfigError('TEST_RECIPIENT is not set in .env (your own inbox for test emails).');
  return { from: env.EMAIL_FROM, testTo: env.TEST_RECIPIENT };
}

// ---- Gmail connection ----

export function gmailStatus(): { clientFile: boolean; connectedAs: string | null; expected: string | null } {
  const env = getEnv();
  const p = paths(env);
  let clientFile = true;
  try {
    loadOAuthClient(p.client);
  } catch {
    clientFile = false;
  }
  return { clientFile, connectedAs: loadToken(p.token)?.email ?? null, expected: env.EMAIL_FROM ?? null };
}

export async function connectGmail(onUrl: (url: string) => void = defaultOpen): Promise<string> {
  const env = getEnv();
  const { from } = requireSender(env);
  const p = paths(env);
  const token = await signIn(loadOAuthClient(p.client), from, p.token, onUrl);
  return token.email;
}

export function disconnectGmail(): boolean {
  return deleteToken(paths(getEnv()).token);
}

function defaultOpen(url: string): void {
  try {
    openExternal(url);
  } catch {
    /* the caller also prints the URL */
  }
}

// ---- Test sending ----

export interface SendDeps {
  getToken: () => Promise<string>;
  sendRaw: (accessToken: string, raw: string) => Promise<string>;
  spacingMs: number;
  /** Settings override (tests). Defaults to .env. */
  env: Env;
  /** Business details override (tests). Defaults to brand.json. */
  brand: Brand;
}

export interface SendSummary {
  attempted: number;
  sent: number;
  failed: number;
  blocked: number;
  remainingToday: number;
}

/**
 * THE test-mode guard. Called immediately before every network send. Throws unless the message is going to
 * the owner's TEST_RECIPIENT and that address is not one of the scraped contacts.
 */
export function assertTestRecipient(db: Db, env: Env, to: string): void {
  if (env.SEND_MODE !== 'test') throw new ConfigError('Only test mode exists. Refusing to send.');
  if (!env.TEST_RECIPIENT || to.toLowerCase() !== env.TEST_RECIPIENT.toLowerCase()) {
    throw new ConfigError(`Refusing to send to ${to}: in test mode emails may only go to TEST_RECIPIENT.`);
  }
  const clash = db.prepare('SELECT 1 FROM contacts WHERE lower(email) = ? LIMIT 1').get(to.toLowerCase());
  if (clash) throw new ConfigError(`TEST_RECIPIENT ${to} is also a saved company contact. Use your own inbox instead.`);
}

/** Subject and body as they arrive in the test inbox: clearly labelled, original text unchanged below. */
export function buildTestEmail(draft: Pick<Draft, 'subject' | 'body' | 'to_email'>, companyName: string): { subject: string; body: string } {
  const banner = [
    '==================== TEST EMAIL ====================',
    `In real use this would go to: ${draft.to_email} (${companyName})`,
    'It was sent only to you. Nothing was sent to them.',
    '====================================================',
    '',
  ].join('\n');
  return { subject: `[TEST → ${draft.to_email}] ${draft.subject}`, body: `${banner}\n${draft.body}` };
}

/**
 * Sends approved drafts to the owner's test inbox. Never emails a company, never marks anything as contacted.
 * `draftIds` limits it to specific drafts; otherwise all approved drafts not yet test-sent are used.
 */
export async function sendTestEmails(
  db: Db,
  input: { draftIds?: number[]; limit: number; resend?: boolean },
  hooks: ProgressHooks = logHooks,
  deps?: Partial<SendDeps>,
): Promise<SendSummary> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new ValidationError('--limit must be an integer 1-100');
  const env = deps?.env ?? getEnv();
  const { from, testTo } = requireSender(env);
  assertTestRecipient(db, env, testTo); // fail fast before doing anything
  const brand = deps?.brand ?? getBrand();
  const sends = new SendModel(db);
  const drafts = new DraftModel(db);
  const p = paths(env);
  const client = deps?.getToken ? null : loadOAuthClient(p.client);
  const getToken = deps?.getToken ?? (() => getAccessToken(client!, p.token, from));
  const sendRaw = deps?.sendRaw ?? gmailSendRaw;
  const spacing = deps?.spacingMs ?? SEND_SPACING_MS;

  const remaining = env.TEST_SEND_MAX_PER_DAY - sends.sentLast24h();
  if (remaining <= 0) throw new LimitError(`Reached TEST_SEND_MAX_PER_DAY (${env.TEST_SEND_MAX_PER_DAY} in the last 24h). Try again later.`);

  let queue = drafts.list('approved', 10_000);
  if (input.draftIds) {
    const wanted = new Set(input.draftIds);
    const missing = input.draftIds.filter((id) => !queue.some((d) => d.id === id));
    if (missing.length) throw new ValidationError(`Only approved drafts can be sent. Not approved: #${missing.join(', #')}`);
    queue = queue.filter((d) => wanted.has(d.id));
  } else if (!input.resend) {
    queue = queue.filter((d) => !sends.lastSentForDraft(d.id));
  }
  queue = queue.slice(0, Math.min(input.limit, remaining));
  const summary: SendSummary = { attempted: queue.length, sent: 0, failed: 0, blocked: 0, remainingToday: remaining };
  if (queue.length === 0) {
    hooks.step('Nothing to send: no approved drafts waiting (each is test-sent once unless you choose to resend).');
    return summary;
  }
  hooks.step(`Sending ${queue.length} test email(s) to ${testTo} (never to the companies)...`);
  const accessToken = await getToken();

  for (const [i, d] of queue.entries()) {
    const company = d.company_name ?? d.domain;
    const base = { done: i + 1, total: queue.length, name: company, intended: d.to_email };
    const check = checkDraft(db, d.id, brand); // rules again: company/contact/brand may have changed since approval
    const test = buildTestEmail(d, company);
    if (check.problems.length) {
      sends.record({ draftId: d.id, sentTo: testTo, intendedTo: d.to_email, subject: test.subject, status: 'blocked', error: check.problems.join('; ') });
      summary.blocked++;
      hooks.sent({ ...base, ok: false, error: `blocked: ${check.problems.join('; ')}` });
      continue;
    }
    try {
      const raw = buildPlainTextMessage({
        fromName: brand.signature,
        fromEmail: from,
        to: testTo,
        subject: test.subject,
        body: test.body,
        headers: { 'List-Unsubscribe': `<mailto:${from}?subject=unsubscribe>` },
      });
      assertTestRecipient(db, env, testTo); // last check, immediately before the network call
      const id = await sendRaw(accessToken, raw);
      sends.record({ draftId: d.id, sentTo: testTo, intendedTo: d.to_email, subject: test.subject, status: 'sent', gmailMessageId: id });
      summary.sent++;
      hooks.sent({ ...base, ok: true, error: null });
    } catch (err) {
      sends.record({ draftId: d.id, sentTo: testTo, intendedTo: d.to_email, subject: test.subject, status: 'failed', error: (err as Error).message });
      summary.failed++;
      hooks.sent({ ...base, ok: false, error: (err as Error).message });
      if (err instanceof ConfigError) break; // auth/config problems won't fix themselves mid-run
    }
    if (i < queue.length - 1 && spacing > 0) await sleep(spacing);
  }
  summary.remainingToday = env.TEST_SEND_MAX_PER_DAY - sends.sentLast24h();
  return summary;
}
