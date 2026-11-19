import type { Db } from '../db/connection.ts';
import { ValidationError } from '../lib/errors.ts';
import { QUALIFICATIONS, type Company, type Qualification } from './types.ts';

export interface NewQualification {
  companyId: number;
  decision: Qualification;
  decisionReason: string;
  isPropertyManager: string;
  servesOntario: string;
  segments: string[];
  servicesFit: string[];
  bestContactId: number | null;
  contactName: string | null;
  contactTitle: string | null;
  summary: string;
  modelReason: string;
  notes: string[];
  provider: string;
  model: string;
  promptVersion: number;
}

export interface QualificationRow {
  id: number;
  company_id: number;
  decision: Qualification;
  decision_reason: string;
  segments: string;
  services_fit: string;
  best_contact_id: number | null;
  best_contact_email: string | null;
  contact_name: string | null;
  contact_title: string | null;
  summary: string;
  model_reason: string;
  notes: string | null;
  model: string;
  created_at: string;
}

export class QualificationModel {
  constructor(private readonly db: Db) {}

  /** Crawled companies without a verdict (or all crawled ones when redo is set). Manual verdicts are never overwritten. */
  listPending(limit: number, redo: boolean): Company[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new ValidationError(`Invalid limit ${limit}`);
    return this.db
      .prepare(
        `SELECT * FROM companies
         WHERE status = 'crawled'
           AND (qualification IS NULL OR (? = 1 AND qualification_source = 'llm'))
         ORDER BY id LIMIT ?`,
      )
      .all(redo ? 1 : 0, limit) as Company[];
  }

  /** Saves the model verdict and updates the company, atomically. */
  save(q: NewQualification): number {
    if (!QUALIFICATIONS.includes(q.decision)) throw new ValidationError(`Unknown decision ${q.decision}`);
    return this.db.transaction(() => {
      if (q.bestContactId !== null) {
        const owns = this.db.prepare('SELECT 1 FROM contacts WHERE id = ? AND company_id = ?').get(q.bestContactId, q.companyId);
        if (!owns) throw new ValidationError(`Contact ${q.bestContactId} does not belong to company ${q.companyId}`);
      }
      const row = this.db
        .prepare(
          `INSERT INTO qualifications (company_id, decision, decision_reason, is_property_manager, serves_ontario, segments,
             services_fit, best_contact_id, contact_name, contact_title, summary, model_reason, notes, provider, model, prompt_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          q.companyId,
          q.decision,
          q.decisionReason.slice(0, 500),
          q.isPropertyManager,
          q.servesOntario,
          JSON.stringify(q.segments),
          JSON.stringify(q.servicesFit),
          q.bestContactId,
          q.contactName,
          q.contactTitle,
          q.summary.slice(0, 500),
          q.modelReason.slice(0, 500),
          q.notes.length ? q.notes.join('; ').slice(0, 1000) : null,
          q.provider,
          q.model,
          q.promptVersion,
        ) as { id: number };
      this.setCompanyDecision(q.companyId, q.decision, 'llm', q.decisionReason);
      return row.id;
    })();
  }

  /** Human override; sticks across `qualify --redo`. */
  decideManually(companyId: number, decision: Qualification, reason: string): void {
    if (!QUALIFICATIONS.includes(decision)) {
      throw new ValidationError(`Decision must be one of: ${QUALIFICATIONS.join(', ')}`);
    }
    const r = reason.trim();
    if (r.length < 3 || r.length > 300) throw new ValidationError('Reason must be 3-300 characters');
    if (decision === 'qualified') this.assertCanQualify(companyId);
    this.setCompanyDecision(companyId, decision, 'manual', r);
  }

  /** A qualified company must be emailable: not opted out, and with at least one recorded contact. */
  private assertCanQualify(companyId: number): void {
    if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new ValidationError(`Invalid company id ${companyId}`);
    const row = this.db
      .prepare(
        `SELECT c.status, c.status_reason, (SELECT COUNT(*) FROM contacts WHERE company_id = c.id) AS contacts
         FROM companies c WHERE c.id = ?`,
      )
      .get(companyId) as { status: string; status_reason: string | null; contacts: number } | undefined;
    if (!row) throw new ValidationError(`Company ${companyId} not found`);
    if (row.status === 'opted_out') {
      throw new ValidationError(`Company ${companyId} is opted_out (${row.status_reason}); it cannot be qualified.`);
    }
    if (row.contacts === 0) {
      throw new ValidationError(
        `Company ${companyId} has no contacts, so there is no one to email. ` +
          `Add one first: npm run cli -- contact add ${companyId} <email> --source <url>`,
      );
    }
  }

  latestFor(companyId: number): QualificationRow | undefined {
    return this.db
      .prepare(
        `SELECT q.*, c.email AS best_contact_email FROM qualifications q
         LEFT JOIN contacts c ON c.id = q.best_contact_id
         WHERE q.company_id = ? ORDER BY q.id DESC LIMIT 1`,
      )
      .get(companyId) as QualificationRow | undefined;
  }

  /** All model verdicts for a company, newest first. */
  historyFor(companyId: number, limit = 10): QualificationRow[] {
    return this.db
      .prepare(
        `SELECT q.*, c.email AS best_contact_email FROM qualifications q
         LEFT JOIN contacts c ON c.id = q.best_contact_id
         WHERE q.company_id = ? ORDER BY q.id DESC LIMIT ?`,
      )
      .all(companyId, limit) as QualificationRow[];
  }

  counts(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT COALESCE(qualification, 'unqualified') AS q, COUNT(*) AS n FROM companies WHERE status = 'crawled' GROUP BY q`)
      .all() as { q: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.q, r.n]));
  }

  private setCompanyDecision(companyId: number, decision: Qualification, source: 'llm' | 'manual', reason: string): void {
    if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new ValidationError(`Invalid company id ${companyId}`);
    const info = this.db
      .prepare(
        `UPDATE companies SET qualification = ?, qualification_source = ?, qualification_reason = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(decision, source, reason.slice(0, 500), companyId);
    if (info.changes !== 1) throw new ValidationError(`Company ${companyId} not found`);
  }
}
