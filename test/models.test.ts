import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCompany } from '../src/controllers/companyController.ts';
import { buildQuery } from '../src/controllers/discoverController.ts';
import { openDb } from '../src/db/connection.ts';
import { ValidationError } from '../src/lib/errors.ts';
import { CompanyModel } from '../src/models/companyModel.ts';
import { EvidenceModel } from '../src/models/evidenceModel.ts';
import { PlacesUsageModel } from '../src/models/placesUsageModel.ts';

test('companies are deduplicated by registrable domain and place id', () => {
  const db = openDb(':memory:');
  const m = new CompanyModel(db);
  const a = m.addIfNew({ website: 'https://www.acmepm.ca/', source: 'google_places', googlePlaceId: 'p1' });
  assert.equal(a.created, true);
  assert.equal(m.addIfNew({ website: 'http://acmepm.ca/contact', source: 'manual' }).created, false);
  assert.equal(m.addIfNew({ website: 'https://acme-other.ca', source: 'google_places', googlePlaceId: 'p1' }).created, false);
  assert.equal(m.addIfNew({ website: 'https://bpm.ca', source: 'manual' }).created, true);
  db.close();
});

test('addCompany rejects social/directory sites', () => {
  const db = openDb(':memory:');
  assert.throws(() => addCompany(db, 'https://www.facebook.com/acmepm'), ValidationError);
  db.close();
});

test('crawl queue, status updates and retry cap', () => {
  const db = openDb(':memory:');
  const m = new CompanyModel(db);
  const { id } = m.addIfNew({ website: 'acmepm.ca', source: 'manual' });
  assert.equal(m.listForCrawl(10, false).length, 1);
  for (let i = 0; i < 3; i++) m.setCrawlResult(id, 'crawl_failed', 'timeout');
  assert.equal(m.listForCrawl(10, false).length, 0);
  assert.equal(m.listForCrawl(10, true).length, 0, 'gives up after 3 attempts');
  assert.throws(() => m.setCrawlResult(id, 'bogus' as never, null), ValidationError);
  assert.throws(() => m.setCrawlResult(9999, 'crawled', null), ValidationError);
  assert.throws(() => m.listForCrawl(0, false), ValidationError);

  const b = m.addIfNew({ website: 'spa-site.ca', source: 'manual' });
  m.setCrawlResult(b.id, 'no_contacts', null);
  assert.equal(m.listForCrawl(10, false).length, 0);
  assert.equal(m.listForCrawl(10, false, true).length, 1, 'no_contacts re-queued on request');
  db.close();
});

test('contacts keep provenance and are unique per company', () => {
  const db = openDb(':memory:');
  const { id } = new CompanyModel(db).addIfNew({ website: 'acmepm.ca', source: 'manual' });
  const ev = new EvidenceModel(db);
  const pageId = ev.savePage({
    companyId: id,
    url: 'https://acmepm.ca/',
    finalUrl: 'https://acmepm.ca/',
    httpStatus: 200,
    snapshotPath: 'snapshots/1/x.html',
    sha256: 'a'.repeat(64),
    fetchedAt: new Date().toISOString(),
  });
  const c = {
    companyId: id,
    email: 'info@acmepm.ca',
    kind: 'role' as const,
    onCompanyDomain: true,
    method: 'mailto' as const,
    context: 'ctx',
    sourcePageId: pageId,
    firstSeenAt: new Date().toISOString(),
  };
  assert.equal(ev.addContact(c), true);
  assert.equal(ev.addContact(c), false);
  assert.equal(ev.contactsFor(id)[0]!.source_url, 'https://acmepm.ca/');
  assert.throws(() => ev.savePage({ companyId: id, url: 'u', finalUrl: 'u', httpStatus: 200, snapshotPath: 'p', sha256: 'bad', fetchedAt: '' }));
  db.close();
});

test('places usage ledger counts reserved requests', () => {
  const db = openDb(':memory:');
  const u = new PlacesUsageModel(db);
  const id = u.reserve('q', 1);
  assert.equal(u.countLast24h(), 1);
  assert.equal(u.lastSuccessfulRun('q'), undefined);
  u.complete(id, 200, 20);
  assert.ok(u.lastSuccessfulRun('q'));
  db.close();
});

test('buildQuery validates city and substitutes templates', () => {
  assert.equal(buildQuery('Toronto'), 'property management companies in Toronto, Ontario');
  assert.equal(buildQuery("St. Catharines", 'condo management {city} ON'), 'condo management St. Catharines ON');
  assert.equal(buildQuery('Ottawa', 'airbnb management'), 'airbnb management in Ottawa, Ontario');
  for (const bad of ['', 'T', '1234', 'Toronto; DROP', 'x'.repeat(100)]) assert.throws(() => buildQuery(bad), ValidationError, bad);
});
