import type { CompanyStatus, Qualification } from '../models/types.ts';
import { log } from './logger.ts';

/** Progress events from long-running controllers. The CLI logs them; the menu renders them nicely. */
export interface ProgressHooks {
  /** Phase-level message ("Searching Google for ..."). */
  step(message: string): void;
  /** Minor detail most users don't need (skipped pages etc.). */
  detail(message: string): void;
  warn(message: string): void;
  crawled(e: { done: number; total: number; domain: string; name: string | null; status: CompanyStatus; reason: string | null; added: number }): void;
  qualified(e: {
    done: number;
    total: number;
    domain: string;
    name: string | null;
    decision: Qualification | null;
    reason: string;
    notes: string[];
  }): void;
  drafted(e: { done: number; total: number; domain: string; name: string | null; subject: string | null; aiOpener: boolean; problem: string | null }): void;
  sent(e: { done: number; total: number; name: string; intended: string; ok: boolean; error: string | null }): void;
}

/** Default: timestamped log lines, same as the original CLI output. */
export const logHooks: ProgressHooks = {
  step: (m) => log.info(m),
  detail: (m) => log.warn(`  ${m}`),
  warn: (m) => log.warn(m),
  crawled: (e) =>
    log.info(
      `[${e.done}/${e.total}] ${e.domain} -> ${e.status}${e.reason ? ` (${e.reason})` : ''}${e.added ? `, ${e.added} new contact(s)` : ''}`,
    ),
  qualified: (e) =>
    log.info(
      `[${e.done}/${e.total}] ${e.domain} -> ${e.decision ?? 'failed'}: ${e.reason}${e.notes.length ? ` [${e.notes.join('; ')}]` : ''}`,
    ),
  drafted: (e) =>
    log.info(
      `[${e.done}/${e.total}] ${e.domain} -> ${e.problem ? `skipped: ${e.problem}` : `"${e.subject}" (${e.aiOpener ? 'AI opener' : 'standard opener'})`}`,
    ),
  sent: (e) => log.info(`[${e.done}/${e.total}] ${e.name} (written for ${e.intended}) -> ${e.ok ? 'test email sent' : `NOT sent: ${e.error}`}`),
};
