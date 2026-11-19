import type { Db } from '../db/connection.ts';
import { normalizeWebsiteUrl, registrableDomain } from '../lib/domain.ts';
import { ValidationError } from '../lib/errors.ts';
import {
  COMPANY_STATUSES,
  QUALIFICATIONS,
  type Company,
  type CompanySource,
  type CompanyStatus,
  type Qualification,
} from './types.ts';

export interface NewCompany {
  name?: string | null;
  website: string;
  address?: string | null;
  phone?: string | null;
  source: CompanySource;
  googlePlaceId?: string | null;
  discoveryQuery?: string | null;
}

export type UpsertResult = { id: number; created: true } | { id: number; created: false; reason: string };

const MAX_CRAWL_ATTEMPTS = 3;

const cleanText = (v: string | null | undefined, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t.slice(0, max);
};

export class CompanyModel {
  constructor(private readonly db: Db) {}

  /** Inserts a company unless its domain or Google place id already exists. */
  addIfNew(input: NewCompany): UpsertResult {
    if (input.source !== 'google_places' && input.source !== 'manual') {
      throw new ValidationError(`Unknown source "${String(input.source)}"`);
    }
    const url = normalizeWebsiteUrl(input.website);
    const domain = registrableDomain(url.hostname);
    if (!domain) throw new ValidationError(`Cannot determine domain for ${url.href}`);
    const placeId = cleanText(input.googlePlaceId, 300);

    return this.db.transaction((): UpsertResult => {
      const byDomain = this.db.prepare('SELECT id FROM companies WHERE domain = ?').get(domain) as { id: number } | undefined;
      if (byDomain) return { id: byDomain.id, created: false, reason: `domain ${domain} already known` };
      if (placeId) {
        const byPlace = this.db.prepare('SELECT id FROM companies WHERE google_place_id = ?').get(placeId) as
          | { id: number }
          | undefined;
        if (byPlace) return { id: byPlace.id, created: false, reason: 'place already known' };
      }
      const row = this.db
        .prepare(
          `INSERT INTO companies (name, domain, website_url, address, phone, source, google_place_id, discovery_query)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          cleanText(input.name, 300),
          domain,
          url.href,
          cleanText(input.address, 500),
          cleanText(input.phone, 50),
          input.source,
          placeId,
          cleanText(input.discoveryQuery, 300),
        ) as { id: number };
      return { id: row.id, created: true };
    })();
  }

  getById(id: number): Company | undefined {
    assertId(id);
    return this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Company | undefined;
  }

  /** Companies awaiting a crawl; optionally retries failures (below the attempt cap) and no-contact sites. */
  listForCrawl(limit: number, retryFailed: boolean, retryNoContacts = false): Company[] {
    assertLimit(limit);
    return this.db
      .prepare(
        `SELECT * FROM companies
         WHERE status = 'new'
            OR (? = 1 AND status = 'crawl_failed' AND crawl_attempts < ?)
            OR (? = 1 AND status = 'no_contacts' AND crawl_attempts < ?)
         ORDER BY id LIMIT ?`,
      )
      .all(retryFailed ? 1 : 0, MAX_CRAWL_ATTEMPTS, retryNoContacts ? 1 : 0, MAX_CRAWL_ATTEMPTS, limit) as Company[];
  }

  setCrawlResult(id: number, status: CompanyStatus, reason: string | null): void {
    assertId(id);
    if (!COMPANY_STATUSES.includes(status)) throw new ValidationError(`Unknown status "${status}"`);
    const info = this.db
      .prepare(
        `UPDATE companies
         SET status = ?, status_reason = ?, crawl_attempts = crawl_attempts + 1,
             crawled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(status, reason ? reason.slice(0, 500) : null, id);
    if (info.changes !== 1) throw new ValidationError(`Company ${id} not found`);
  }

  /**
   * After a person adds a contact by hand: make the company eligible for `qualify`.
   * A model verdict is cleared so the new contact is considered; a manual verdict is kept.
   * Returns true if a model verdict was cleared.
   */
  markManualContact(id: number): boolean {
    assertId(id);
    const before = this.getById(id);
    if (!before || before.status === 'opted_out') throw new ValidationError(`Company ${id} not found or opted out`);
    const clearVerdict = before.qualification_source === 'llm';
    this.db
      .prepare(
        `UPDATE companies SET status = 'crawled',
           status_reason = CASE WHEN status = 'crawled' THEN status_reason ELSE 'contact added manually' END,
           qualification = CASE WHEN ? THEN NULL ELSE qualification END,
           qualification_source = CASE WHEN ? THEN NULL ELSE qualification_source END,
           qualification_reason = CASE WHEN ? THEN NULL ELSE qualification_reason END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(clearVerdict ? 1 : 0, clearVerdict ? 1 : 0, clearVerdict ? 1 : 0, id);
    return clearVerdict;
  }

  list(filter: { status?: CompanyStatus; qualification?: Qualification }, limit: number): Company[] {
    assertLimit(limit);
    if (filter.status !== undefined && !COMPANY_STATUSES.includes(filter.status)) {
      throw new ValidationError(`Unknown status "${filter.status}". Use one of: ${COMPANY_STATUSES.join(', ')}`);
    }
    if (filter.qualification !== undefined && !QUALIFICATIONS.includes(filter.qualification)) {
      throw new ValidationError(`Unknown qualification "${filter.qualification}". Use one of: ${QUALIFICATIONS.join(', ')}`);
    }
    return this.db
      .prepare(
        `SELECT * FROM companies
         WHERE (? IS NULL OR status = ?) AND (? IS NULL OR qualification = ?)
         ORDER BY id LIMIT ?`,
      )
      .all(filter.status ?? null, filter.status ?? null, filter.qualification ?? null, filter.qualification ?? null, limit) as Company[];
  }

  /** Case-insensitive match on name or domain, best matches (prefix) first. */
  search(term: string, limit: number): Company[] {
    assertLimit(limit);
    const t = term.trim().toLowerCase();
    if (t.length === 0) {
      return this.db.prepare('SELECT * FROM companies ORDER BY updated_at DESC LIMIT ?').all(limit) as Company[];
    }
    if (t.length > 100) throw new ValidationError('Search text is too long');
    const escaped = t.replace(/[!%_]/g, (c) => `!${c}`); // "!" is the LIKE escape char below
    const like = `%${escaped}%`;
    const prefix = `${escaped}%`;
    return this.db
      .prepare(
        `SELECT * FROM companies
         WHERE lower(COALESCE(name, '')) LIKE ? ESCAPE '!' OR domain LIKE ? ESCAPE '!'
         ORDER BY (lower(COALESCE(name, '')) LIKE ? ESCAPE '!' OR domain LIKE ? ESCAPE '!') DESC, name
         LIMIT ?`,
      )
      .all(like, like, prefix, prefix, limit) as Company[];
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM companies GROUP BY status').all() as {
      status: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}

function assertId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError(`Invalid id: ${id}`);
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000) {
    throw new ValidationError(`Invalid limit: ${limit}`);
  }
}
