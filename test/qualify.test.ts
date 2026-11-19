import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { openDb } from '../src/db/connection.ts';
import { ValidationError } from '../src/lib/errors.ts';
import { CompanyModel } from '../src/models/companyModel.ts';
import { EvidenceModel } from '../src/models/evidenceModel.ts';
import { QualificationModel } from '../src/models/qualificationModel.ts';
import { parseAndValidate } from '../src/services/llm/ollamaProvider.ts';
import type { JsonRequest, JsonResponse, LlmProvider } from '../src/services/llm/types.ts';
import {
  applyGuardrails,
  buildSystemPrompt,
  buildUserPrompt,
  servicesForSegments,
  verifySegments,
  qualifyCompany,
  rankContacts,
  type CompanyInput,
  type ModelOutput,
} from '../src/services/qualify/qualifier.ts';

const INPUT: CompanyInput = {
  name: 'Acme PM',
  domain: 'acmepm.ca',
  address: '1 King St W, Toronto, ON',
  contacts: [
    { id: 1, email: 'info@acmepm.ca', kind: 'role', on_company_domain: 1, context: 'General inquiries' },
    { id: 2, email: 'jane.doe@acmepm.ca', kind: 'personal', on_company_domain: 1, context: 'Jane Doe, Property Manager' },
    { id: 3, email: 'dev@webagency.com', kind: 'personal', on_company_domain: 0, context: 'Site by WebAgency' },
  ],
  pages: [{ url: 'https://acmepm.ca/', text: 'Acme PM manages condominiums across Toronto. Jane Doe, Property Manager.' }],
};

const OUT: ModelOutput = {
  is_property_manager: 'yes',
  serves_ontario: 'yes',
  segments: ['condo', 'condo'],
  services_fit: ['junk_removal', 'residential_cleaning'],
  best_contact_email: 'Jane.Doe@acmepm.ca',
  contact_name: 'Jane Doe',
  contact_title: 'Property Manager',
  summary: 'Toronto condo manager.',
  reason: 'Manages condominiums.',
};

const OFFERED = ['junk_removal', 'residential_cleaning', 'commercial_cleaning', 'airbnb_turnover_cleaning'] as const;

test('services come from verified property types and offered services only (never moving)', () => {
  const r = applyGuardrails({ ...OUT, services_fit: ['moving_help', 'moving_with_truck'] }, INPUT, OFFERED);
  assert.deepEqual(r.servicesFit, ['junk_removal', 'residential_cleaning'], 'condo -> junk + residential cleaning');
  const noneOffered = applyGuardrails(OUT, INPUT, ['airbnb_turnover_cleaning']);
  assert.equal(noneOffered.decision, 'needs_review', 'no offered service fits a condo manager -> human decides');
});

test('property types without supporting words on the site are dropped', () => {
  const r = applyGuardrails({ ...OUT, segments: ['condo', 'short_term_rental', 'commercial'] }, INPUT, OFFERED);
  assert.deepEqual(r.segments, ['condo']);
  assert.match(r.notes.join(), /not mentioned on the site: short_term_rental, commercial/);
  assert.ok(!r.servicesFit.includes('airbnb_turnover_cleaning'));

  assert.deepEqual(verifySegments(['short_term_rental', 'student_housing'], 'We manage Airbnb units near McMaster').kept, [
    'short_term_rental',
    'student_housing',
  ]);
  assert.deepEqual(verifySegments(['other'], 'anything').kept, [], '"other" is never claimed');
  // Real false positives seen on Hamilton/Vaughan sites:
  const bios = 'Alex completed a bachelor from the University of Toronto. Norm is a Sheridan College certified inspector.';
  assert.deepEqual(verifySegments(['student_housing'], bios).kept, [], 'staff bios are not student housing');
  assert.deepEqual(verifySegments(['commercial'], 'we comply with rules on commercial electronic messages').kept, []);
  assert.deepEqual(verifySegments(['student_housing'], 'off-campus student rentals for McMaster').kept, ['student_housing']);
  assert.deepEqual(verifySegments(['commercial'], 'we manage commercial properties and office buildings').kept, ['commercial']);
  assert.deepEqual(servicesForSegments([], OFFERED), ['junk_removal', 'residential_cleaning'], 'unknown type -> general services');
  assert.deepEqual(servicesForSegments(['commercial'], OFFERED), ['junk_removal', 'commercial_cleaning']);
});

test('system prompt only lists offered services', () => {
  const p = buildSystemPrompt(OFFERED);
  assert.doesNotMatch(p, /moving/);
  assert.match(p, /condo: junk_removal, residential_cleaning/);
  assert.match(p, /short_term_rental: airbnb_turnover_cleaning, residential_cleaning/);
  assert.throws(() => buildSystemPrompt([]));
});

test('guardrails accept a valid verdict and dedupe arrays', () => {
  const r = applyGuardrails(OUT, INPUT);
  assert.equal(r.decision, 'qualified');
  assert.equal(r.bestContactId, 2);
  assert.equal(r.contactName, 'Jane Doe');
  assert.deepEqual(r.segments, ['condo']);
  assert.deepEqual(r.notes, []);
});

test('guardrails reject invented emails and fall back to ranked contact', () => {
  const r = applyGuardrails({ ...OUT, best_contact_email: 'ceo@acmepm.ca' }, INPUT);
  assert.equal(r.bestContactId, 2, 'own-domain personal ranks first');
  assert.equal(r.contactName, null, 'name not trusted for fallback contact');
  assert.match(r.notes.join(), /unknown email/);
});

test('guardrails drop names/titles not present on the page', () => {
  const r = applyGuardrails({ ...OUT, contact_name: 'John Smith', contact_title: 'CEO' }, INPUT);
  assert.equal(r.contactName, null);
  assert.equal(r.contactTitle, null);
  assert.equal(r.decision, 'qualified');
});

test('decision rules', () => {
  assert.equal(applyGuardrails({ ...OUT, is_property_manager: 'no' }, INPUT).decision, 'disqualified');
  assert.equal(applyGuardrails({ ...OUT, serves_ontario: 'no' }, INPUT).decision, 'disqualified');
  assert.equal(applyGuardrails({ ...OUT, is_property_manager: 'unsure' }, INPUT).decision, 'needs_review');
  assert.equal(applyGuardrails({ ...OUT, serves_ontario: 'unsure' }, INPUT).decision, 'needs_review');
  assert.equal(applyGuardrails({ ...OUT, services_fit: [] }, INPUT).decision, 'qualified', 'services are derived, not taken from the model');
  assert.equal(applyGuardrails(OUT, INPUT, ['commercial_cleaning']).decision, 'needs_review', 'nothing offered fits');
  assert.equal(applyGuardrails({ ...OUT, best_contact_email: null }, { ...INPUT, contacts: [] }).decision, 'needs_review');
});

test('no website text forces needs_review even if the model says yes', () => {
  const r = applyGuardrails({ ...OUT, contact_name: null, contact_title: null }, { ...INPUT, pages: [] });
  assert.equal(r.decision, 'needs_review');
  assert.match(r.decisionReason, /verify by hand/);
});

test('rankContacts prefers own-domain, then named people', () => {
  assert.deepEqual(
    rankContacts(INPUT.contacts).map((c) => c.id),
    [2, 1, 3],
  );
});

test('buildUserPrompt respects text budget and lists candidates', () => {
  const big = { ...INPUT, pages: Array.from({ length: 10 }, (_, i) => ({ url: `https://acmepm.ca/${i}`, text: 'x'.repeat(5000) })) };
  const p = buildUserPrompt(big);
  assert.ok(p.length < 16_000, `prompt length ${p.length}`);
  assert.match(p, /info@acmepm\.ca \(role, company domain\)/);
  assert.match(p, /dev@webagency\.com \(personal, external domain\)/);
});

test('parseAndValidate reports JSON and schema errors', () => {
  const s = z.object({ a: z.enum(['x']) });
  assert.deepEqual(parseAndValidate('{"a":"x"}', s), { ok: true, data: { a: 'x' } });
  assert.equal(parseAndValidate('not json', s).ok, false);
  const bad = parseAndValidate('{"a":"y"}', s);
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /^a:/);
});

class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  constructor(private readonly reply: unknown) {}
  async healthCheck(): Promise<void> {}
  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResponse<T>> {
    return { data: req.schema.parse(this.reply), model: this.model, attempts: 1, durationMs: 1 };
  }
}

test('qualifyCompany end-to-end with fake provider, then persisted', async () => {
  const r = await qualifyCompany(new FakeLlm(OUT), INPUT, OFFERED);
  assert.equal(r.decision, 'qualified');

  const db = openDb(':memory:');
  const { id } = new CompanyModel(db).addIfNew({ website: 'acmepm.ca', source: 'manual' });
  new CompanyModel(db).setCrawlResult(id, 'crawled', null);
  const ev = new EvidenceModel(db);
  const pageId = ev.savePage({
    companyId: id,
    url: 'https://acmepm.ca/',
    finalUrl: 'https://acmepm.ca/',
    httpStatus: 200,
    snapshotPath: 'snapshots/1/a.html',
    sha256: 'b'.repeat(64),
    fetchedAt: new Date().toISOString(),
  });
  ev.addContact({
    companyId: id,
    email: 'jane.doe@acmepm.ca',
    kind: 'personal',
    onCompanyDomain: true,
    method: 'text',
    context: null,
    sourcePageId: pageId,
    firstSeenAt: new Date().toISOString(),
  });
  const contactId = ev.contactsFor(id)[0]!.id;

  const q = new QualificationModel(db);
  assert.equal(q.listPending(10, false).length, 1);
  q.save({ companyId: id, ...r, bestContactId: contactId, provider: 'fake', model: r.model, promptVersion: 1 });
  assert.equal(q.listPending(10, false).length, 0);
  assert.equal(q.listPending(10, true).length, 1, 'redo includes LLM verdicts');
  assert.equal(q.latestFor(id)!.best_contact_email, 'jane.doe@acmepm.ca');

  q.decideManually(id, 'disqualified', 'Called them, not interested');
  assert.equal(q.listPending(10, true).length, 0, 'manual verdicts survive redo');
  assert.throws(() => q.decideManually(id, 'bogus' as never, 'xxx'), ValidationError);
  assert.throws(() => q.decideManually(id, 'qualified', ''), ValidationError);
  assert.throws(() => q.decideManually(999, 'qualified', 'reason'), ValidationError);
  assert.throws(
    () => q.save({ companyId: id, ...r, bestContactId: 9999, provider: 'fake', model: 'x', promptVersion: 1 }),
    ValidationError,
    'contact must belong to company',
  );
  db.close();
});

test('schema rejects malformed model output', () => {
  const fake = new FakeLlm({ ...OUT, is_property_manager: 'maybe' });
  return assert.rejects(qualifyCompany(fake, INPUT, OFFERED));
});
