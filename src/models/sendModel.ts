import type { Db } from '../db/connection.ts';

export type SendStatus = 'sent' | 'failed' | 'blocked';

export interface SendRow {
  id: number;
  draft_id: number;
  mode: 'test';
  sent_to: string;
  intended_to: string;
  subject: string;
  status: SendStatus;
  gmail_message_id: string | null;
  error: string | null;
  created_at: string;
}

/** Log of every send attempt. Test sends never mark a company or contact as emailed. */
export class SendModel {
  constructor(private readonly db: Db) {}

  record(s: { draftId: number; sentTo: string; intendedTo: string; subject: string; status: SendStatus; gmailMessageId?: string | null; error?: string | null }): number {
    const row = this.db
      .prepare(
        `INSERT INTO sends (draft_id, mode, sent_to, intended_to, subject, status, gmail_message_id, error)
         VALUES (?, 'test', ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(s.draftId, s.sentTo, s.intendedTo, s.subject.slice(0, 300), s.status, s.gmailMessageId ?? null, s.error?.slice(0, 500) ?? null) as {
      id: number;
    };
    return row.id;
  }

  /** Successful test sends in the last rolling 24 hours. */
  sentLast24h(): number {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return (this.db.prepare("SELECT COUNT(*) n FROM sends WHERE status = 'sent' AND created_at >= ?").get(since) as { n: number }).n;
  }

  list(limit: number): (SendRow & { company_name: string | null; domain: string })[] {
    return this.db
      .prepare(
        `SELECT s.*, c.name AS company_name, c.domain FROM sends s
         JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id
         ORDER BY s.id DESC LIMIT ?`,
      )
      .all(limit) as (SendRow & { company_name: string | null; domain: string })[];
  }

  lastSentForDraft(draftId: number): SendRow | undefined {
    return this.db
      .prepare("SELECT * FROM sends WHERE draft_id = ? AND status = 'sent' ORDER BY id DESC LIMIT 1")
      .get(draftId) as SendRow | undefined;
  }
}
