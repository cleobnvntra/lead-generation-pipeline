import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addManualContact } from '../src/controllers/contactController.ts';
import { openDb } from '../src/db/connection.ts';
import { ValidationError } from '../src/lib/errors.ts';
import { CompanyModel } from '../src/models/companyModel.ts';
import { EvidenceModel } from '../src/models/evidenceModel.ts';
import { QualificationModel } from '../src/models/qualificationModel.ts';

function setup() {
  const db = openDb(':memory:');
  const companies = new CompanyModel(db);
  const { id } = companies.addIfNew({ website: 'https://cornerstoneselect.ca', source: 'google_places' });
  companies.setCrawlResult(id, 'crawl_failed', 'homepage: HTTP 403');
  return { db, id, companies };
}

test('adds a manual contact with provenance and makes the company qualifiable', () => {
  const { db, id, companies } = setup();
  const res = addManualContact(db, {
    companyId: id,
    email: 'Hello@CornerstoneSelect.ca',
    sourceUrl: 'https://cornerstoneselect.ca/contact-us-2/',
    note: 'footer of contact page',
  });
  assert.equal(res.created, true);

  const [c] = new EvidenceModel(db).contactsFor(id);
  assert.equal(c!.email, 'hello@cornerstoneselect.ca');
  assert.equal(c!.method, 'manual');
  assert.equal(c!.kind, 'role');
  assert.equal(c!.source_url, 'https://cornerstoneselect.ca/contact-us-2/');
  const [page] = new EvidenceModel(db).pagesFor(id);
  assert.equal(page!.capture, 'manual');
  assert.equal(page!.http_status, null);

  assert.equal(companies.getById(id)!.status, 'crawled');
  assert.equal(new QualificationModel(db).listPending(10, false).length, 1);

  const again = addManualContact(db, { companyId: id, email: 'hello@cornerstoneselect.ca', sourceUrl: 'cornerstoneselect.ca/contact-us-2/' });
  assert.equal(again.created, false);
  db.close();
});

test('a new contact clears a model verdict but keeps a manual one', () => {
  const { db, id } = setup();
  const quals = new QualificationModel(db);
  addManualContact(db, { companyId: id, email: 'hello@cornerstoneselect.ca', sourceUrl: 'cornerstoneselect.ca/contact' });
  const contactId = new EvidenceModel(db).contactsFor(id)[0]!.id;
  quals.save({
    companyId: id,
    decision: 'qualified',
    decisionReason: 'fits',
    isPropertyManager: 'yes',
    servesOntario: 'yes',
    segments: ['condo'],
    servicesFit: ['junk_removal'],
    bestContactId: contactId,
    contactName: null,
    contactTitle: null,
    summary: 's',
    modelReason: 'r',
    notes: [],
    provider: 'fake',
    model: 'fake',
    promptVersion: 2,
  });
  assert.equal(quals.listPending(10, false).length, 0);

  const dup = addManualContact(db, { companyId: id, email: 'hello@cornerstoneselect.ca', sourceUrl: 'cornerstoneselect.ca/contact' });
  assert.equal(dup.verdictCleared, false, 'existing contact does not reopen the verdict');

  const res = addManualContact(db, { companyId: id, email: 'jane@cornerstoneselect.ca', sourceUrl: 'cornerstoneselect.ca/team' });
  assert.equal(res.verdictCleared, true);
  assert.equal(quals.listPending(10, false).length, 1, 'only this company is re-queued');

  quals.decideManually(id, 'qualified', 'Checked by hand');
  const kept = addManualContact(db, { companyId: id, email: 'bob@cornerstoneselect.ca', sourceUrl: 'cornerstoneselect.ca/team' });
  assert.equal(kept.verdictCleared, false);
  assert.equal(kept.manualVerdictKept, true);
  assert.equal(new CompanyModel(db).getById(id)!.qualification, 'qualified');
  db.close();
});

test('decide qualified requires a contact and a non-opted-out company', () => {
  const { db, id, companies } = setup();
  const quals = new QualificationModel(db);
  assert.throws(() => quals.decideManually(id, 'qualified', 'Looks good'), /no contacts/);
  quals.decideManually(id, 'disqualified', 'Not a fit'); // other verdicts need no contact
  assert.equal(companies.getById(id)!.qualification, 'disqualified');

  addManualContact(db, { companyId: id, email: 'hello@cornerstoneselect.ca', sourceUrl: 'cornerstoneselect.ca/contact' });
  quals.decideManually(id, 'qualified', 'Checked by hand');
  assert.equal(companies.getById(id)!.qualification, 'qualified');

  companies.setCrawlResult(id, 'opted_out', 'site states: "no solicitation"');
  assert.throws(() => quals.decideManually(id, 'qualified', 'Checked by hand'), /opted_out/);
  assert.throws(() => quals.decideManually(999, 'qualified', 'Checked by hand'), /not found/);
  db.close();
});

test('rejects bad input', () => {
  const { db, id, companies } = setup();
  const base = { companyId: id, email: 'hello@cornerstoneselect.ca', sourceUrl: 'https://cornerstoneselect.ca/contact' };
  for (const bad of [
    { ...base, companyId: 999 },
    { ...base, email: 'not-an-email' },
    { ...base, email: 'careers@cornerstoneselect.ca' },
    { ...base, sourceUrl: 'https://facebook.com/cornerstone' },
    { ...base, sourceUrl: 'ftp://cornerstoneselect.ca' },
    { ...base, snapshotFile: join(tmpdir(), 'does-not-exist.html') },
  ]) {
    assert.throws(() => addManualContact(db, bad), ValidationError, JSON.stringify(bad));
  }

  companies.setCrawlResult(id, 'opted_out', 'site states: "no solicitation"');
  assert.throws(() => addManualContact(db, base), /opted_out/);
  db.close();
});

test('snapshot must contain the address', () => {
  const { db, id } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'tl-snap-'));
  const without = join(dir, 'page.html');
  writeFileSync(without, '<html><body>Call us</body></html>');
  assert.throws(
    () => addManualContact(db, { companyId: id, email: 'hello@cornerstoneselect.ca', sourceUrl: 'cornerstoneselect.ca', snapshotFile: without }),
    /does not appear/,
  );
  const wrongExt = join(dir, 'page.pdf');
  writeFileSync(wrongExt, 'x');
  assert.throws(
    () => addManualContact(db, { companyId: id, email: 'hello@cornerstoneselect.ca', sourceUrl: 'cornerstoneselect.ca', snapshotFile: wrongExt }),
    /\.html/,
  );
  db.close();
});
