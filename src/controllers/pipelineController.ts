import type { Db } from '../db/connection.ts';
import { logHooks, type ProgressHooks } from '../lib/progress.ts';
import type { LlmProvider } from '../services/llm/types.ts';
import { crawl, type CrawlSummary } from './crawlController.ts';
import { discover, type DiscoverInput, type DiscoverSummary } from './discoverController.ts';
import { qualify, type QualifySummary } from './qualifyController.ts';

export interface FindLeadsSummary {
  discover: DiscoverSummary;
  crawl: CrawlSummary;
  qualify: QualifySummary;
}

/**
 * One step for a city: search Google, check every new website, then let the AI review them.
 * Also picks up companies left unchecked/unreviewed by earlier interrupted runs.
 */
export async function findLeads(
  db: Db,
  llm: LlmProvider,
  input: DiscoverInput,
  hooks: ProgressHooks = logHooks,
): Promise<FindLeadsSummary> {
  const d = await discover(db, input, hooks);
  const c = await crawl(db, { limit: 1000, retryFailed: false }, hooks);
  const q = await qualify(db, llm, { limit: 1000, redo: false }, hooks);
  return { discover: d, crawl: c, qualify: q };
}
