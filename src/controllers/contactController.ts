import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { getEnv } from '../config/env.ts';
import type { Db } from '../db/connection.ts';
import { normalizeWebsiteUrl, sameSite } from '../lib/domain.ts';
import { ValidationError } from '../lib/errors.ts';
import { CompanyModel } from '../models/companyModel.ts';
import { EvidenceModel } from '../models/evidenceModel.ts';
import { classifyEmail, cleanEmail, emailOnDomain, htmlToText } from '../services/crawler/extract.ts';
import { SnapshotStore } from '../services/crawler/snapshotStore.ts';

export interface ManualContactInput {
  companyId: number;
  email: string;
  sourceUrl: string;
  note?: string;
  snapshotFile?: string;
}

const MAX_SNAPSHOT_BYTES = 20_000_000;

/**
 * Adds a contact a person found on the company's own website in their browser.
 * Same rules as the crawler: address must pass the email filters and the source must be the company's site.
 */
export function addManualContact(
  db: Db,
  input: ManualContactInput,
): { contactId: number; created: boolean; verdictCleared: boolean; manualVerdictKept: boolean } {
  const companies = new CompanyModel(db);
  const company = companies.getById(input.companyId);
  if (!company) throw new ValidationError(`Company #${input.companyId} not found. See: npm run cli -- leads`);
  if (company.status === 'opted_out') {
    throw new ValidationError(`Company #${company.id} is opted_out (${company.status_reason}); its site refuses unsolicited email.`);
  }

  const email = cleanEmail(input.email);
  if (!email) {
    throw new ValidationError(`"${input.email}" is not a usable address (invalid, placeholder, or an excluded mailbox like careers@/privacy@).`);
  }

  const source = normalizeWebsiteUrl(input.sourceUrl);
  if (!sameSite(source.hostname, company.domain)) {
    throw new ValidationError(
      `Source ${source.hostname} is not ${company.domain}. Contacts must come from the company's own website.`,
    );
  }

  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  const snapshot = input.snapshotFile ? storeSnapshot(company.id, input.snapshotFile, email) : null;

  const evidence = new EvidenceModel(db);
  return db.transaction(() => {
    const pageId = evidence.saveManualSource({ companyId: company.id, url: source.href, note, snapshot });
    const created = evidence.addContact({
      companyId: company.id,
      email,
      kind: classifyEmail(email),
      onCompanyDomain: emailOnDomain(email, company.domain),
      method: 'manual',
      context: note ?? `added manually from ${source.href}`,
      sourcePageId: pageId,
      firstSeenAt: new Date().toISOString(),
    });
    // Only a genuinely new contact should reopen the verdict.
    const verdictCleared = created ? companies.markManualContact(company.id) : false;
    const row = db.prepare('SELECT id FROM contacts WHERE company_id = ? AND email = ?').get(company.id, email) as { id: number };
    return { contactId: row.id, created, verdictCleared, manualVerdictKept: company.qualification_source === 'manual' };
  })();
}

/** Copies a browser-saved page (Ctrl+S) into the snapshot store, and checks the address is actually in it. */
function storeSnapshot(companyId: number, file: string, email: string): { path: string; sha256: string } {
  if (!existsSync(file)) throw new ValidationError(`Snapshot file not found: ${file}`);
  const ext = extname(file).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') throw new ValidationError('--snapshot must be an .html/.htm file (browser "Save page as")');
  const size = statSync(file).size;
  if (size === 0 || size > MAX_SNAPSHOT_BYTES) throw new ValidationError(`Snapshot must be 1 byte to 20 MB, got ${size} bytes`);

  const html = readFileSync(file, 'utf8');
  const text = htmlToText(html).toLowerCase();
  if (!text.includes(email) && !html.toLowerCase().includes(`mailto:${email}`)) {
    throw new ValidationError(`${email} does not appear in ${file}. Save the page that shows the address, or omit --snapshot.`);
  }
  const saved = new SnapshotStore(getEnv().DATA_DIR).save(companyId, html);
  return { path: saved.relativePath, sha256: saved.sha256 };
}
