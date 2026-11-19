import type { Db } from '../db/connection.ts';

/** Ledger of billable Google Places requests. */
export class PlacesUsageModel {
  constructor(private readonly db: Db) {}

  /** Requests in the last rolling 24h. Stricter than Google's Pacific-midnight quota day, never looser. */
  countLast24h(): number {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM places_requests WHERE requested_at >= ?').get(since) as {
      n: number;
    };
    return row.n;
  }

  /** Requests since the 1st of the current (local) month. Informational; Google's billing is authoritative. */
  countThisMonth(): number {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM places_requests WHERE requested_at >= ?')
      .get(start.toISOString()) as { n: number };
    return row.n;
  }

  /** Records a request *before* it is sent so crashes can never under-count. Returns the ledger id. */
  reserve(query: string, pageNumber: number): number {
    const row = this.db
      .prepare('INSERT INTO places_requests (query, page_number) VALUES (?, ?) RETURNING id')
      .get(query, pageNumber) as { id: number };
    return row.id;
  }

  complete(id: number, httpStatus: number, resultCount: number | null): void {
    this.db.prepare('UPDATE places_requests SET http_status = ?, result_count = ? WHERE id = ?').run(httpStatus, resultCount, id);
  }

  /** Most recent successful run of an identical query, if any. */
  lastSuccessfulRun(query: string): string | undefined {
    const row = this.db
      .prepare('SELECT MAX(requested_at) AS t FROM places_requests WHERE query = ? AND http_status = 200')
      .get(query) as { t: string | null };
    return row.t ?? undefined;
  }
}
