import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getBrand, type Brand } from '../src/config/brand.ts';
import { openDb } from '../src/db/connection.ts';
import { ConfigError, ValidationError } from '../src/lib/errors.ts';
import { CompanyModel } from '../src/models/companyModel.ts';
import { DraftModel } from '../src/models/draftModel.ts';
import { EvidenceModel } from '../src/models/evidenceModel.ts';
import {
  buildOpenerSystemPrompt,
  buildSubject,
  checkOpener,
  cityFromAddress,
  draftEmail,
  findPlaceholders,
  firstName,
  shortCompanyName,
  type DraftInput,
} from '../src/services/draft/drafter.ts';
import type { JsonRequest, JsonResponse, LlmProvider } from '../src/services/llm/types.ts';
import { buildSystemPrompt } from '../src/services/qualify/qualifier.ts';

const BRAND: Brand = {
  businessName: 'Example Services',
  phone: '416-555-0100',
  website: 'https://www.example.com/',
  signature: 'Example Services Team',
  mailingAddress: null,
  offeredServices: ['junk_removal', 'residential_cleaning', 'commercial_cleaning', 'airbnb_turnover_cleaning'],
};

const INPUT: DraftInput = {
  companyName: 'University Property Management Services Inc.',
  domain: 'machousing.com',
  address: '1 Main St W, Hamilton, ON L8P 1A1, Canada',
  summary: 'Manages student housing near McMaster University in Hamilton, Ontario.',
  segments: ['student_housing'],
  services: ['junk_removal', 'moving_help', 'residential_cleaning'],
  contact: { email: 'houses@machousing.com', name: null },
};

class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  constructor(private readonly reply: unknown | Error) {}
  async healthCheck(): Promise<void> {}
  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResponse<T>> {
    if (this.reply instanceof Error) throw this.reply;
    return { data: req.schema.parse(this.reply), model: this.model, attempts: 1, durationMs: 1 };
  }
}

test('address, name and greeting helpers', () => {
  assert.equal(cityFromAddress('110 Charlton Ave W, Hamilton, ON L8P 2C6'), 'Hamilton');
  assert.equal(cityFromAddress('5 King St, St. Catharines, Ontario L2R 3H2, Canada'), 'St. Catharines');
  assert.equal(cityFromAddress('somewhere'), null);
  assert.equal(cityFromAddress(null), null);
  assert.equal(shortCompanyName('Wilson Blanchard Management, An Associa Company', 'x.ca'), 'Wilson Blanchard Management');
  assert.equal(shortCompanyName('Acme PM Inc.', 'x.ca'), 'Acme PM');
  assert.equal(shortCompanyName(null, 'acmepm.ca'), 'acmepm.ca');
  assert.equal(firstName('Andrea Brown'), 'Andrea');
  assert.equal(firstName('sandro j. zuliani'), null, 'lowercase is not trusted as a name');
  assert.equal(firstName(null), null);
});

test('subjects follow the services and never mention moving', () => {
  assert.equal(buildSubject(['junk_removal', 'residential_cleaning'], 'Hamilton'), 'Cleaning and junk removal for your Hamilton properties');
  assert.equal(buildSubject(['airbnb_turnover_cleaning'], null), 'Turnover cleaning for your short-term rentals');
  assert.equal(buildSubject(['commercial_cleaning', 'junk_removal'], null), 'Commercial cleaning and junk removal for your buildings');
  assert.equal(buildSubject(['junk_removal'], 'Ottawa'), 'Junk removal for your Ottawa properties');
});

test('prompts use the business name and offered services from brand.json', () => {
  const p = buildOpenerSystemPrompt(BRAND);
  assert.match(p, /from Example Services, a small Ontario business offering junk removal, residential cleaning/);
  assert.match(p, /do not introduce Example Services/);
  assert.doesNotMatch(p, /moving/);
  assert.match(buildSystemPrompt(BRAND.offeredServices, 'Example Services'), /^You classify companies for Example Services,/);
  assert.match(buildSystemPrompt(BRAND.offeredServices), /^You classify companies for our business,/);
  assert.ok(checkOpener('Example has noticed you manage condos in Hamilton this year.', BRAND.offeredServices, 'Example Services').includes('self-promotion'));
  assert.deepEqual(checkOpener('I noticed you manage condos in Hamilton, a busy market for turnovers.', BRAND.offeredServices, 'Example Services'), []);
});

test('opener checks reject risky AI text', () => {
  const offered = BRAND.offeredServices;
  assert.deepEqual(checkOpener('I noticed you manage student housing near McMaster, so turnover season must keep your team busy.', offered), []);
  const cases: [string, string][] = [
    ['Hi there, I saw you manage condos in Hamilton and wanted to reach out.', 'greeting'],
    ['Your moving season must be busy with so many tenants changing units.', 'mentions moving'],
    ['I saw your site at www.acme.ca and your condo work in Hamilton.', 'link'],
    ['Call 905-555-1234 to learn about our impressive results here.', 'phone number'],
    ['Your amazing portfolio of condos in Hamilton caught our eye today.', 'flattery'],
    ['We can give you 20% off your next turnover clean in Hamilton.', 'price/offer'],
    ['Hello [NAME], your condos in Hamilton look well run and busy.', 'placeholder/markup'],
    ['Your condo portfolio in Hamilton looks busy right now!', 'exclamation'],
  ];
  for (const [text, problem] of cases) assert.ok(checkOpener(text, offered).includes(problem), `${problem}: ${text}`);
});

test('draft uses the AI opener when safe, never lists moving, keeps CASL footer', async () => {
  const opener = 'I noticed you manage student housing near McMaster, so turnover season must keep your team busy.';
  const out = await draftEmail(new FakeLlm({ opener }), BRAND, INPUT);
  assert.equal(out.openerSource, 'llm');
  assert.deepEqual(out.services, ['junk_removal', 'residential_cleaning']);
  assert.match(out.body, /^Hi University Property Management Services team,/);
  assert.ok(out.body.includes(opener));
  assert.doesNotMatch(out.body, /moving help|moving with|truck/i);
  assert.match(out.body, /Example Services · https:\/\/www\.example\.com\/ · 416-555-0100/);
  assert.match(out.body, /reply "unsubscribe"/);
  assert.deepEqual(findPlaceholders(out.body), ['[MAILING ADDRESS]']);
  assert.equal(out.subject, 'Cleaning and junk removal for your Hamilton properties');
});

test('draft falls back to a standard opener when the AI is unsafe, failing or absent', async () => {
  const unsafe = await draftEmail(new FakeLlm({ opener: 'Your moving season in Hamilton must be really busy for the team.' }), BRAND, INPUT);
  assert.equal(unsafe.openerSource, 'fallback');
  assert.match(unsafe.notes.join(), /mentions moving/);
  assert.match(unsafe.body, /I came across University Property Management Services while looking for property managers in Hamilton\./);

  const failing = await draftEmail(new FakeLlm(new Error('Ollama down')), BRAND, INPUT);
  assert.equal(failing.openerSource, 'fallback');
  assert.match(failing.notes.join(), /Ollama down/);

  const none = await draftEmail(null, BRAND, { ...INPUT, contact: { email: 'a@b.ca', name: 'Andrea Brown' } });
  assert.match(none.body, /^Hi Andrea,/);

  await assert.rejects(draftEmail(null, BRAND, { ...INPUT, services: ['moving_help'] }), /no offered service/);
});

test('subject names a city only when the company description agrees with the address', async () => {
  const ancaster = { ...INPUT, address: '1 Wilson St, Ancaster, ON L9G 1N1' };
  assert.equal((await draftEmail(null, BRAND, ancaster)).subject, 'Cleaning and junk removal for your properties');
  assert.equal((await draftEmail(null, BRAND, INPUT)).subject, 'Cleaning and junk removal for your Hamilton properties');
});

test('a real mailing address replaces the placeholder', async () => {
  const out = await draftEmail(null, { ...BRAND, mailingAddress: '123 Example Rd, Toronto, ON M1M 1M1' }, INPUT);
  assert.deepEqual(findPlaceholders(out.body), []);
  assert.match(out.body, /123 Example Rd/);
});

test('brand.json is validated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-brand-'));
  const write = (o: unknown) => {
    const f = join(dir, `b${Math.random()}.json`);
    writeFileSync(f, JSON.stringify(o));
    return f;
  };
  assert.equal(getBrand(write(BRAND)).businessName, 'Example Services');
  assert.throws(() => getBrand(write({ ...BRAND, offeredServices: [] })), ConfigError);
  assert.throws(() => getBrand(write({ ...BRAND, offeredServices: ['dog_walking'] })), ConfigError);
  assert.throws(() => getBrand(write({ ...BRAND, website: 'example.com' })), ConfigError);
  assert.throws(() => getBrand(write({ ...BRAND, phone: 'call us' })), ConfigError);
  assert.throws(() => getBrand(join(dir, 'missing.json')), ConfigError);
});

test('drafts: one per company, eligible only when ready, approved ones are never overwritten', () => {
  const db = openDb(':memory:');
  const companies = new CompanyModel(db);
  const { id } = companies.addIfNew({ website: 'machousing.com', source: 'manual' });
  companies.setCrawlResult(id, 'crawled', null);
  const ev = new EvidenceModel(db);
  const pageId = ev.saveManualSource({ companyId: id, url: 'https://machousing.com/', note: null, snapshot: null });
  ev.addContact({ companyId: id, email: 'houses@machousing.com', kind: 'role', onCompanyDomain: true, method: 'manual', context: null, sourcePageId: pageId, firstSeenAt: new Date().toISOString() });
  const contactId = ev.contactsFor(id)[0]!.id;
  const drafts = new DraftModel(db);

  assert.equal(drafts.listEligible(10, false).length, 0, 'not ready to email yet');
  db.prepare("UPDATE companies SET qualification = 'qualified', qualification_source = 'manual' WHERE id = ?").run(id);
  assert.equal(drafts.listEligible(10, false).length, 1);

  const base = { companyId: id, contactId, toEmail: 'houses@machousing.com', subject: 'S', body: 'B', services: ['junk_removal'], openerSource: 'fallback' as const, notes: [], model: null, promptVersion: 1 };
  const draftId = drafts.save(base);
  assert.equal(drafts.listEligible(10, false).length, 0);
  assert.equal(drafts.listEligible(10, true).length, 1, 'redo includes unapproved drafts');
  assert.equal(drafts.save({ ...base, subject: 'S2' }), draftId, 'same row is replaced');
  assert.equal(drafts.get(draftId)!.subject, 'S2');

  assert.throws(() => drafts.save({ ...base, toEmail: 'someone@else.ca' }), ValidationError);
  assert.throws(() => drafts.save({ ...base, contactId: 9999 }), ValidationError);
  assert.throws(() => drafts.save({ ...base, subject: '' }), ValidationError);

  db.prepare("UPDATE drafts SET status = 'approved' WHERE id = ?").run(draftId);
  assert.throws(() => drafts.save(base), /approved; it will not be overwritten/);
  assert.equal(drafts.listEligible(10, true).length, 0);
  db.close();
});
