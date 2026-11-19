import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Brand } from '../src/config/brand.ts';
import { getEnv, type Env } from '../src/config/env.ts';
import { assertTestRecipient, buildTestEmail, sendTestEmails } from '../src/controllers/sendController.ts';
import { openDb } from '../src/db/connection.ts';
import { ConfigError, LimitError, ValidationError } from '../src/lib/errors.ts';
import type { ProgressHooks } from '../src/lib/progress.ts';
import { CompanyModel } from '../src/models/companyModel.ts';
import { DraftModel } from '../src/models/draftModel.ts';
import { EvidenceModel } from '../src/models/evidenceModel.ts';
import { SendModel } from '../src/models/sendModel.ts';
import { buildBody } from '../src/services/draft/drafter.ts';
import { buildPlainTextMessage, encodeWord } from '../src/services/gmail/mime.ts';
import { emailFromIdToken, loadOAuthClient } from '../src/services/gmail/oauth.ts';

const TEST_TO = 'owner.test@personal-inbox.ca';
const ENV: Env = { ...getEnv(), SEND_MODE: 'test', EMAIL_FROM: 'sender@example-company.ca', TEST_RECIPIENT: TEST_TO, TEST_SEND_MAX_PER_DAY: 3 };
const BRAND: Brand = {
  businessName: 'Example Services',
  phone: '416-555-0100',
  website: 'https://www.example.com/',
  signature: 'Example Services Team',
  mailingAddress: null,
  offeredServices: ['junk_removal', 'residential_cleaning', 'commercial_cleaning', 'airbnb_turnover_cleaning'],
};
const quiet: ProgressHooks = { step() {}, detail() {}, warn() {}, crawled() {}, qualified() {}, drafted() {}, sent() {} };

function setup(companyCount = 1) {
  const db = openDb(':memory:');
  const companies = new CompanyModel(db);
  const ev = new EvidenceModel(db);
  const drafts = new DraftModel(db);
  const draftIds: number[] = [];
  for (let i = 0; i < companyCount; i++) {
    const { id } = companies.addIfNew({ website: `acme${i}pm.ca`, name: `Acme ${i} PM`, source: 'manual' });
    companies.setCrawlResult(id, 'crawled', null);
    const pageId = ev.saveManualSource({ companyId: id, url: `https://acme${i}pm.ca/`, note: null, snapshot: null });
    ev.addContact({ companyId: id, email: `info@acme${i}pm.ca`, kind: 'role', onCompanyDomain: true, method: 'manual', context: null, sourcePageId: pageId, firstSeenAt: new Date().toISOString() });
    db.prepare("UPDATE companies SET qualification = 'qualified', qualification_source = 'manual' WHERE id = ?").run(id);
    const body = buildBody(BRAND, { companyName: `Acme ${i} PM`, domain: `acme${i}pm.ca`, address: null, summary: null, segments: [], services: ['junk_removal'], contact: { email: `info@acme${i}pm.ca`, name: null } }, 'I came across your company in Hamilton.');
    const draftId = drafts.save({ companyId: id, contactId: ev.contactsFor(id)[0]!.id, toEmail: `info@acme${i}pm.ca`, subject: 'Junk removal for your properties', body, services: ['junk_removal'], openerSource: 'fallback', notes: [], model: null, promptVersion: 1 });
    drafts.approve(draftId);
    draftIds.push(draftId);
  }
  const sentRaw: string[] = [];
  const deps = { env: ENV, brand: BRAND, spacingMs: 0, getToken: async () => 'fake-token', sendRaw: async (_t: string, raw: string) => (sentRaw.push(raw), `gmail-${sentRaw.length}`) };
  return { db, drafts, draftIds, sentRaw, deps, companies };
}

function decodeBody(raw: string): string {
  const b64 = raw.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
  return Buffer.from(b64, 'base64').toString('utf8');
}

test('the guard only allows TEST_RECIPIENT, never a scraped contact', () => {
  const { db } = setup();
  assert.doesNotThrow(() => assertTestRecipient(db, ENV, TEST_TO));
  assert.doesNotThrow(() => assertTestRecipient(db, ENV, TEST_TO.toUpperCase()));
  assert.throws(() => assertTestRecipient(db, ENV, 'info@acme0pm.ca'), ConfigError);
  assert.throws(() => assertTestRecipient(db, { ...ENV, TEST_RECIPIENT: undefined }, TEST_TO), ConfigError);
  assert.throws(() => assertTestRecipient(db, { ...ENV, TEST_RECIPIENT: 'info@acme0pm.ca' }, 'info@acme0pm.ca'), /also a saved company contact/);
  assert.throws(() => assertTestRecipient(db, { ...ENV, SEND_MODE: 'live' as never }, TEST_TO), /Only test mode/);
});

test('test sends go only to the test inbox, are labelled, and logged; nothing is marked contacted', async () => {
  const { db, drafts, draftIds, sentRaw, deps } = setup(2);
  const res = await sendTestEmails(db, { limit: 5 }, quiet, deps);
  assert.equal(res.sent, 2);
  assert.equal(sentRaw.length, 2);
  for (const raw of sentRaw) {
    assert.match(raw, new RegExp(`^To: <${TEST_TO.replace(/\./g, '\\.')}>$`, 'm'));
    assert.doesNotMatch(raw.split('\r\n\r\n')[0]!, /acme\dpm\.ca>/, 'company address never in To');
    assert.match(raw, /^From: Example Services Team <sender@example-company\.ca>$/m);
    assert.match(decodeBody(raw), /TEST EMAIL[\s\S]*would go to: info@acme\dpm\.ca[\s\S]*Nothing was sent to them/);
  }
  const log = new SendModel(db).list(10);
  assert.ok(log.every((s) => s.status === 'sent' && s.sent_to === TEST_TO && s.mode === 'test'));
  assert.ok(draftIds.every((id) => drafts.require(id).status === 'approved'), 'draft status unchanged');

  const again = await sendTestEmails(db, { limit: 5 }, quiet, deps);
  assert.equal(again.attempted, 0, 'each approved draft is test-sent once unless resend');
  const resend = await sendTestEmails(db, { draftIds: [draftIds[0]!], limit: 1 }, quiet, deps);
  assert.equal(resend.sent, 1, 'a specific draft can be resent');
  db.close();
});

test('approval rules run again at send time', async () => {
  const { db, draftIds, sentRaw, deps, companies } = setup();
  const companyId = new DraftModel(db).require(draftIds[0]!).company_id;
  companies.setCrawlResult(companyId, 'opted_out', 'site states: "no solicitation"');
  const res = await sendTestEmails(db, { limit: 5 }, quiet, deps);
  assert.equal(res.blocked, 1);
  assert.equal(sentRaw.length, 0);
  assert.equal(new SendModel(db).list(5)[0]!.status, 'blocked');
  db.close();
});

test('refuses unapproved drafts, a contact as test inbox, and the daily cap', async () => {
  const { db, drafts, draftIds, deps } = setup(1);
  drafts.reset(draftIds[0]!);
  await assert.rejects(sendTestEmails(db, { draftIds: [draftIds[0]!], limit: 1 }, quiet, deps), ValidationError);
  drafts.approve(draftIds[0]!);
  await assert.rejects(sendTestEmails(db, { limit: 1 }, quiet, { ...deps, env: { ...ENV, TEST_RECIPIENT: 'info@acme0pm.ca' } }), ConfigError);
  await assert.rejects(sendTestEmails(db, { limit: 0 }, quiet, deps), ValidationError);

  const capped = { ...deps, env: { ...ENV, TEST_SEND_MAX_PER_DAY: 1 } };
  assert.equal((await sendTestEmails(db, { limit: 5 }, quiet, capped)).sent, 1);
  await assert.rejects(sendTestEmails(db, { draftIds: [draftIds[0]!], limit: 1 }, quiet, capped), LimitError);
  db.close();
});

test('a failed send is logged and does not stop the log from being accurate', async () => {
  const { db, deps } = setup(1);
  const res = await sendTestEmails(db, { limit: 5 }, quiet, { ...deps, sendRaw: async () => { throw new Error('Gmail 500'); } });
  assert.equal(res.failed, 1);
  assert.equal(new SendModel(db).list(5)[0]!.error, 'Gmail 500');
  assert.equal(new SendModel(db).sentLast24h(), 0, 'failures do not use up the daily cap');
  db.close();
});

test('message building rejects header injection and encodes non-ASCII subjects', () => {
  const base = { fromName: 'Example Services Team', fromEmail: 'sender@example-company.ca', to: TEST_TO, subject: 'Hello', body: 'Hi\nthere' };
  assert.throws(() => buildPlainTextMessage({ ...base, subject: 'Hi\r\nBcc: victim@x.ca' }), /line breaks/);
  assert.throws(() => buildPlainTextMessage({ ...base, to: 'a@b.ca, c@d.ca' }), /Invalid to/);
  assert.throws(() => buildPlainTextMessage({ ...base, headers: { 'Bad Header': 'x' } }), /header name/);
  const raw = buildPlainTextMessage({ ...base, subject: '[TEST → info@acme.ca] Cleaning for your properties' });
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.equal(decodeBody(raw), 'Hi\r\nthere');
  for (const word of encodeWord('→'.repeat(60)).split('\r\n ')) assert.ok(word.length <= 75, `encoded word too long: ${word.length}`);
  assert.equal(encodeWord('Example Services Team'), 'Example Services Team');
});

test('test subject and banner', () => {
  const t = buildTestEmail({ subject: 'Junk removal', body: 'Body', to_email: 'info@acme.ca' }, 'Acme PM');
  assert.equal(t.subject, '[TEST → info@acme.ca] Junk removal');
  assert.match(t.body, /^=+ TEST EMAIL =+\nIn real use this would go to: info@acme\.ca \(Acme PM\)/);
  assert.ok(t.body.endsWith('Body'));
});

test('sign-in helpers: client file validation and id_token email', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-oauth-'));
  const good = join(dir, 'c.json');
  writeFileSync(good, JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'fake-test-secret' } }));
  assert.equal(loadOAuthClient(good).clientId, '123-abc.apps.googleusercontent.com');
  const web = join(dir, 'w.json');
  writeFileSync(web, JSON.stringify({ web: { client_id: 'x.apps.googleusercontent.com', client_secret: 'y'.repeat(12) } }));
  assert.throws(() => loadOAuthClient(web), /Desktop-app/);
  assert.throws(() => loadOAuthClient(join(dir, 'missing.json')), /not found/);

  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  assert.equal(emailFromIdToken(jwt({ email: 'SENDER@example-company.ca', email_verified: true })), 'sender@example-company.ca');
  assert.equal(emailFromIdToken(jwt({ email: 'sender@example-company.ca', email_verified: false })), null, 'unverified email rejected');
  assert.equal(emailFromIdToken('garbage'), null);
  assert.equal(emailFromIdToken(undefined), null);
});
