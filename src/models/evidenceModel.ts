import type { Db } from '../db/connection.ts';
import { ValidationError } from '../lib/errors.ts';
import type { Contact, ContactKind, ExtractionMethod, Page } from './types.ts';

export interface NewPage {
  companyId: number;
  url: string;
  finalUrl: string;
  httpStatus: number;
  snapshotPath: string;
  sha256: string;
  fetchedAt: string;
  /** e.g. "rendered by headless browser"; null for plain HTTP fetches. */
  note?: string | null;
}

export interface NewContact {
  companyId: number;
  email: string;
  kind: ContactKind;
  onCompanyDomain: boolean;
  method: ExtractionMethod;
  context: string | null;
  sourcePageId: number;
  firstSeenAt: string;
}

/** Pages, contacts and opt-out findings: the provenance trail for every lead. */
export class EvidenceModel {
  constructor(private readonly db: Db) {}

  savePage(p: NewPage): number {
    if (!/^[a-f0-9]{64}$/.test(p.sha256)) throw new ValidationError('sha256 must be 64 hex chars');
    if (!Number.isInteger(p.httpStatus) || p.httpStatus < 100 || p.httpStatus > 599) {
      throw new ValidationError(`Invalid HTTP status ${p.httpStatus}`);
    }
    const row = this.db
      .prepare(
        `INSERT INTO pages (company_id, url, final_url, http_status, snapshot_path, sha256, fetched_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, url) DO UPDATE SET
           final_url = excluded.final_url, http_status = excluded.http_status,
           snapshot_path = excluded.snapshot_path, sha256 = excluded.sha256, fetched_at = excluded.fetched_at,
           capture = 'crawler', note = excluded.note
         RETURNING id`,
      )
      .get(p.companyId, p.url, p.finalUrl, p.httpStatus, p.snapshotPath, p.sha256, p.fetchedAt, p.note ?? null) as {
      id: number;
    };
    return row.id;
  }

  /**
   * Records a page a person viewed in their own browser. Reuses an existing row for the same URL
   * (keeping crawler evidence intact) and only fills in a snapshot/note where none exists.
   */
  saveManualSource(s: { companyId: number; url: string; note: string | null; snapshot: { path: string; sha256: string } | null }): number {
    if (s.snapshot && !/^[a-f0-9]{64}$/.test(s.snapshot.sha256)) throw new ValidationError('sha256 must be 64 hex chars');
    const existing = this.db.prepare('SELECT id FROM pages WHERE company_id = ? AND url = ?').get(s.companyId, s.url) as
      | { id: number }
      | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE pages SET
             snapshot_path = COALESCE(snapshot_path, ?), sha256 = COALESCE(sha256, ?), note = COALESCE(note, ?)
           WHERE id = ?`,
        )
        .run(s.snapshot?.path ?? null, s.snapshot?.sha256 ?? null, s.note, existing.id);
      return existing.id;
    }
    const row = this.db
      .prepare(
        `INSERT INTO pages (company_id, url, final_url, http_status, snapshot_path, sha256, fetched_at, capture, note)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'manual', ?) RETURNING id`,
      )
      .get(
        s.companyId,
        s.url,
        s.url,
        s.snapshot?.path ?? null,
        s.snapshot?.sha256 ?? null,
        new Date().toISOString(),
        s.note,
      ) as { id: number };
    return row.id;
  }

  /** Returns true if the contact was new. Keeps the first page an address was seen on. */
  addContact(c: NewContact): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO contacts (company_id, email, kind, on_company_domain, method, context, source_page_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, email) DO NOTHING`,
      )
      .run(
        c.companyId,
        c.email,
        c.kind,
        c.onCompanyDomain ? 1 : 0,
        c.method,
        c.context ? c.context.slice(0, 1000) : null,
        c.sourcePageId,
        c.firstSeenAt,
      );
    return info.changes === 1;
  }

  addOptOut(companyId: number, pageId: number, phrase: string, context: string): void {
    this.db
      .prepare(
        `INSERT INTO optout_findings (company_id, page_id, phrase, context) VALUES (?, ?, ?, ?)
         ON CONFLICT (page_id, phrase) DO NOTHING`,
      )
      .run(companyId, pageId, phrase.slice(0, 200), context.slice(0, 1000));
  }

  contactsFor(companyId: number): (Contact & { source_url: string })[] {
    return this.db
      .prepare(
        `SELECT c.*, p.final_url AS source_url FROM contacts c JOIN pages p ON p.id = c.source_page_id
         WHERE c.company_id = ? ORDER BY c.kind DESC, c.on_company_domain DESC, c.id`,
      )
      .all(companyId) as (Contact & { source_url: string })[];
  }

  optOutsFor(companyId: number): { phrase: string; context: string; url: string }[] {
    return this.db
      .prepare(
        `SELECT o.phrase, o.context, p.final_url AS url FROM optout_findings o JOIN pages p ON p.id = o.page_id
         WHERE o.company_id = ? ORDER BY o.id`,
      )
      .all(companyId) as { phrase: string; context: string; url: string }[];
  }

  pagesFor(companyId: number): Page[] {
    return this.db.prepare('SELECT * FROM pages WHERE company_id = ? ORDER BY id').all(companyId) as Page[];
  }
}
