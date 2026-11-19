import type { Db } from '../db/connection.ts';
import { ValidationError } from '../lib/errors.ts';
import type { Company } from './types.ts';

export const DRAFT_STATUSES = ['draft', 'approved', 'rejected'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface Draft {
  id: number;
  company_id: number;
  contact_id: number;
  to_email: string;
  subject: string;
  body: string;
  services: string;
  opener_source: 'llm' | 'fallback';
  status: DraftStatus;
  notes: string | null;
  model: string | null;
  prompt_version: number;
  created_at: string;
  updated_at: string;
  /** 1 once a person changed the subject or text; such drafts are never regenerated. */
  edited: 0 | 1;
  approved_at: string | null;
  rejected_reason: string | null;
}

export const MAX_SUBJECT = 150;
export const MAX_BODY = 5000;

export interface NewDraft {
  companyId: number;
  contactId: number;
  toEmail: string;
  subject: string;
  body: string;
  services: string[];
  openerSource: 'llm' | 'fallback';
  notes: string[];
  model: string | null;
  promptVersion: number;
}

export class DraftModel {
  constructor(private readonly db: Db) {}

  /** Qualified companies with no draft yet (redo: also unapproved drafts nobody has edited by hand). */
  listEligible(limit: number, redo: boolean): Company[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new ValidationError(`Invalid limit ${limit}`);
    return this.db
      .prepare(
        `SELECT c.* FROM companies c
         LEFT JOIN drafts d ON d.company_id = c.id
         WHERE c.qualification = 'qualified' AND c.status = 'crawled'
           AND (d.id IS NULL OR (? = 1 AND d.status = 'draft' AND d.edited = 0))
         ORDER BY c.id LIMIT ?`,
      )
      .all(redo ? 1 : 0, limit) as Company[];
  }

  /** Saves a person's changes. Any change to an approved draft sends it back for approval. */
  updateContent(id: number, subject: string, body: string): Draft {
    const s = subject.trim();
    const b = body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (s.length < 3 || s.length > MAX_SUBJECT) throw new ValidationError(`Subject must be 3-${MAX_SUBJECT} characters`);
    if (/[\r\n]/.test(s)) throw new ValidationError('Subject must be a single line');
    if (b.trim().length < 20 || b.length > MAX_BODY) throw new ValidationError(`Email text must be 20-${MAX_BODY} characters`);
    const current = this.require(id);
    if (current.status === 'rejected') throw new ValidationError('This draft was rejected. Undo the rejection before editing.');
    if (current.subject === s && current.body === b) return current;
    this.db
      .prepare(
        `UPDATE drafts SET subject = ?, body = ?, edited = 1, status = 'draft', approved_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(s, b, id);
    return this.require(id);
  }

  approve(id: number): void {
    const d = this.require(id);
    if (d.status !== 'draft') throw new ValidationError(`Draft #${id} is ${d.status}; only drafts can be approved.`);
    this.db
      .prepare(
        `UPDATE drafts SET status = 'approved', approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), rejected_reason = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'draft'`,
      )
      .run(id);
  }

  reject(id: number, reason: string): void {
    const r = reason.trim();
    if (r.length < 3 || r.length > 300) throw new ValidationError('Reason must be 3-300 characters');
    const d = this.require(id);
    if (d.status === 'rejected') throw new ValidationError(`Draft #${id} is already rejected.`);
    this.db
      .prepare(
        `UPDATE drafts SET status = 'rejected', rejected_reason = ?, approved_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(r, id);
  }

  /** Undo an approval or rejection. */
  reset(id: number): void {
    const d = this.require(id);
    if (d.status === 'draft') throw new ValidationError(`Draft #${id} is already waiting for approval.`);
    this.db
      .prepare(
        `UPDATE drafts SET status = 'draft', approved_at = NULL, rejected_reason = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(id);
  }

  require(id: number): Draft {
    const d = this.get(id);
    if (!d) throw new ValidationError(`Draft #${id} not found`);
    return d;
  }

  /** Creates or replaces the company's draft. Approved/rejected drafts are never overwritten. */
  save(d: NewDraft): number {
    if (!d.subject.trim() || d.subject.length > 200) throw new ValidationError('Subject must be 1-200 characters');
    if (!d.body.trim() || d.body.length > 5000) throw new ValidationError('Body must be 1-5000 characters');
    return this.db.transaction(() => {
      const contact = this.db.prepare('SELECT email FROM contacts WHERE id = ? AND company_id = ?').get(d.contactId, d.companyId) as
        | { email: string }
        | undefined;
      if (!contact) throw new ValidationError(`Contact ${d.contactId} does not belong to company ${d.companyId}`);
      if (contact.email !== d.toEmail) throw new ValidationError('toEmail must match the contact');
      const existing = this.db.prepare('SELECT id, status, edited FROM drafts WHERE company_id = ?').get(d.companyId) as
        | { id: number; status: DraftStatus; edited: number }
        | undefined;
      if (existing && existing.status !== 'draft') {
        throw new ValidationError(`Draft for company ${d.companyId} is ${existing.status}; it will not be overwritten`);
      }
      if (existing?.edited) throw new ValidationError(`Draft for company ${d.companyId} was edited by hand; it will not be overwritten`);
      const row = this.db
        .prepare(
          `INSERT INTO drafts (company_id, contact_id, to_email, subject, body, services, opener_source, notes, model, prompt_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (company_id) DO UPDATE SET
             contact_id = excluded.contact_id, to_email = excluded.to_email, subject = excluded.subject,
             body = excluded.body, services = excluded.services, opener_source = excluded.opener_source,
             notes = excluded.notes, model = excluded.model, prompt_version = excluded.prompt_version,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           RETURNING id`,
        )
        .get(
          d.companyId,
          d.contactId,
          d.toEmail,
          d.subject,
          d.body,
          JSON.stringify(d.services),
          d.openerSource,
          d.notes.length ? d.notes.join('; ').slice(0, 1000) : null,
          d.model,
          d.promptVersion,
        ) as { id: number };
      return row.id;
    })();
  }

  get(id: number): Draft | undefined {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError(`Invalid draft id ${id}`);
    return this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Draft | undefined;
  }

  forCompany(companyId: number): Draft | undefined {
    return this.db.prepare('SELECT * FROM drafts WHERE company_id = ?').get(companyId) as Draft | undefined;
  }

  list(status: DraftStatus | undefined, limit: number): (Draft & { company_name: string | null; domain: string })[] {
    if (status !== undefined && !DRAFT_STATUSES.includes(status)) throw new ValidationError(`Unknown draft status ${status}`);
    return this.db
      .prepare(
        `SELECT d.*, c.name AS company_name, c.domain FROM drafts d JOIN companies c ON c.id = d.company_id
         WHERE (? IS NULL OR d.status = ?) ORDER BY d.id LIMIT ?`,
      )
      .all(status ?? null, status ?? null, limit) as (Draft & { company_name: string | null; domain: string })[];
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) n FROM drafts GROUP BY status').all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
