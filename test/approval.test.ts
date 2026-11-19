import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Brand } from '../src/config/brand.ts';
import { openDb } from '../src/db/connection.ts';
import { ValidationError } from '../src/lib/errors.ts';
import { CompanyModel } from '../src/models/companyModel.ts';
import { DraftModel } from '../src/models/draftModel.ts';
import { EvidenceModel } from '../src/models/evidenceModel.ts';
import { checkDraftForApproval } from '../src/services/draft/approval.ts';
import { buildBody, type DraftInput } from '../src/services/draft/drafter.ts';

const BRAND: Brand = {
  businessName: 'Example Services',
  phone: '416-555-0100',
  website: 'https://www.example.com/',
  signature: 'Example Services Team',
  mailingAddress: null,
  offeredServices: ['junk_removal', 'residential_cleaning', 'commercial_cleaning', 'airbnb_turnover_cleaning'],
};
const INPUT: DraftInput = {
  companyName: 'Acme PM',
  domain: 'acmepm.ca',
  address: '1 King St, Hamilton, ON L8P 1A1',
  summary: 'Manages condos in Hamilton.',
  segments: ['condo'],
  services: ['junk_removal', 'residential_cleaning'],
  contact: { email: 'info@acmepm.ca', name: null },
};
const BODY = buildBody(BRAND, INPUT, 'I noticed you manage condos in Hamilton.');
const DRAFT = { subject: 'Cleaning and junk removal for your Hamilton properties', body: BODY, to_email: 'info@acmepm.ca' };
const READY = { qualification: 'qualified' as const, status: 'crawled' as const };

test('a generated draft passes; the address placeholder is only a warning while testing', () => {
  const r = checkDraftForApproval(DRAFT, READY, 'info@acmepm.ca', BRAND);
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings.join(), /placeholder/);
});

test('edits that break CASL requirements or the rules block approval', () => {
  const cases: [Partial<typeof DRAFT>, RegExp][] = [
    [{ body: BODY.replace(/^.*unsubscribe.*$/m, '') }, /unsubscribe/],
    [{ body: BODY.replaceAll('Example Services', 'Us') }, /name the business/],
    [{ body: BODY.replaceAll('416-555-0100', '').replaceAll('https://www.example.com/', '') }, /phone number or website/],
    [{ body: BODY.replace('[MAILING ADDRESS]', '') }, /mailing address/],
    [{ body: `${BODY}\nWe also offer moving help with our truck.` }, /moving/],
    [{ body: BODY.replace('Hi Acme PM team,', 'Hi [FIRST NAME],') }, /unfilled placeholders: \[FIRST NAME\]/],
    [{ subject: '[TEST] hello there' }, /must not start with "TEST"/],
    [{ subject: 'Hi' }, /subject must be/],
    [{ subject: 'line one\nline two' }, /single line/],
  ];
  for (const [change, expected] of cases) {
    const r = checkDraftForApproval({ ...DRAFT, ...change }, READY, 'info@acmepm.ca', BRAND);
    assert.ok(r.problems.some((p) => expected.test(p)), `${expected} not in ${JSON.stringify(r.problems)}`);
  }
});

test('company and recipient changes after drafting block approval', () => {
  assert.match(checkDraftForApproval(DRAFT, { ...READY, status: 'opted_out' }, 'info@acmepm.ca', BRAND).problems.join(), /unsolicited/);
  assert.match(checkDraftForApproval(DRAFT, { ...READY, qualification: 'disqualified' }, 'info@acmepm.ca', BRAND).problems.join(), /no longer/);
  assert.match(checkDraftForApproval(DRAFT, READY, null, BRAND).problems.join(), /no longer exists/);
  assert.match(checkDraftForApproval(DRAFT, READY, 'other@acmepm.ca', BRAND).problems.join(), /no longer matches/);
});

test('once a real mailing address is set, the draft must contain it', () => {
  const brand = { ...BRAND, mailingAddress: '123 Example Rd, Toronto, ON M1M 1M1' };
  assert.match(checkDraftForApproval(DRAFT, READY, 'info@acmepm.ca', brand).problems.join(), /mailing address from brand.json/);
  const fixed = { ...DRAFT, body: buildBody(brand, INPUT, 'I noticed you manage condos in Hamilton.') };
  assert.deepEqual(checkDraftForApproval(fixed, READY, 'info@acmepm.ca', brand), { problems: [], warnings: [] });
});

function setup() {
  const db = openDb(':memory:');
  const companies = new CompanyModel(db);
  const { id } = companies.addIfNew({ website: 'acmepm.ca', source: 'manual' });
  companies.setCrawlResult(id, 'crawled', null);
  const ev = new EvidenceModel(db);
  const pageId = ev.saveManualSource({ companyId: id, url: 'https://acmepm.ca/', note: null, snapshot: null });
  ev.addContact({ companyId: id, email: 'info@acmepm.ca', kind: 'role', onCompanyDomain: true, method: 'manual', context: null, sourcePageId: pageId, firstSeenAt: new Date().toISOString() });
  db.prepare("UPDATE companies SET qualification = 'qualified', qualification_source = 'manual' WHERE id = ?").run(id);
  const contactId = ev.contactsFor(id)[0]!.id;
  const drafts = new DraftModel(db);
  const base = { companyId: id, contactId, toEmail: 'info@acmepm.ca', subject: DRAFT.subject, body: BODY, services: ['junk_removal'], openerSource: 'fallback' as const, notes: [], model: null, promptVersion: 1 };
  const draftId = drafts.save(base);
  return { db, drafts, draftId, base };
}

test('approve / reject / undo state changes', () => {
  const { db, drafts, draftId } = setup();
  drafts.approve(draftId);
  assert.equal(drafts.require(draftId).status, 'approved');
  assert.ok(drafts.require(draftId).approved_at);
  assert.throws(() => drafts.approve(draftId), /only drafts can be approved/);
  drafts.reset(draftId);
  assert.equal(drafts.require(draftId).status, 'draft');
  assert.equal(drafts.require(draftId).approved_at, null);
  assert.throws(() => drafts.reset(draftId), /already waiting/);
  assert.throws(() => drafts.reject(draftId, 'x'), ValidationError);
  drafts.reject(draftId, 'Not a fit');
  assert.equal(drafts.require(draftId).rejected_reason, 'Not a fit');
  assert.throws(() => drafts.updateContent(draftId, 'New subject', BODY), /rejected/);
  assert.throws(() => drafts.require(999), /not found/);
  db.close();
});

test('edits mark the draft, send approved drafts back, and are never overwritten by rewrites', () => {
  const { db, drafts, draftId, base } = setup();
  drafts.approve(draftId);
  const edited = drafts.updateContent(draftId, 'A better subject line', `${BODY}\r\n\r\n`);
  assert.equal(edited.edited, 1);
  assert.equal(edited.status, 'draft', 'approval is cleared after an edit');
  assert.ok(!edited.body.endsWith('\n'), 'trailing whitespace trimmed, line endings normalised');
  assert.ok(!edited.body.includes('\r'));

  assert.equal(drafts.listEligible(10, true).length, 0, 'rewrite skips edited drafts');
  assert.throws(() => drafts.save(base), /edited by hand/);

  assert.throws(() => drafts.updateContent(draftId, 'ok', BODY), /Subject must be/);
  assert.throws(() => drafts.updateContent(draftId, 'Two\nlines', BODY), /single line/);
  assert.throws(() => drafts.updateContent(draftId, 'Fine subject', 'too short'), /Email text/);

  const same = drafts.updateContent(draftId, edited.subject, edited.body);
  assert.equal(same.updated_at, edited.updated_at, 'no-op edits change nothing');
  db.close();
});
