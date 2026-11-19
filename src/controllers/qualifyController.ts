import { getBrand } from '../config/brand.ts';
import { getEnv } from '../config/env.ts';
import type { Db } from '../db/connection.ts';
import { ValidationError } from '../lib/errors.ts';
import { logHooks, type ProgressHooks } from '../lib/progress.ts';
import { EvidenceModel } from '../models/evidenceModel.ts';
import { QualificationModel } from '../models/qualificationModel.ts';
import type { Company, Qualification } from '../models/types.ts';
import { loadPageTexts } from '../services/evidenceText.ts';
import type { LlmProvider } from '../services/llm/types.ts';
import { PROMPT_VERSION, qualifyCompany, type CompanyInput } from '../services/qualify/qualifier.ts';

export interface QualifyInput {
  limit: number;
  redo: boolean;
}

export interface QualifySummary {
  companies: number;
  byDecision: Partial<Record<Qualification, number>>;
  failed: number;
  totalMs: number;
  /** Companies (from this or earlier runs) waiting for a human `decide`. */
  awaitingReview: number;
}

export async function qualify(db: Db, llm: LlmProvider, input: QualifyInput, hooks: ProgressHooks = logHooks): Promise<QualifySummary> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
    throw new ValidationError('--limit must be an integer 1-1000');
  }
  const quals = new QualificationModel(db);
  const evidence = new EvidenceModel(db);
  const queue = quals.listPending(input.limit, input.redo);
  const summary: QualifySummary = { companies: queue.length, byDecision: {}, failed: 0, totalMs: 0, awaitingReview: 0 };

  if (queue.length > 0) {
    await llm.healthCheck(); // only needed when there is work; avoids requiring Ollama for a no-op
    hooks.step(`Reviewing ${queue.length} compan${queue.length === 1 ? 'y' : 'ies'} with the AI model (${llm.model})...`);
  }
  const started = Date.now();
  for (const [i, company] of queue.entries()) {
    const base = { done: i + 1, total: queue.length, domain: company.domain, name: company.name };
    try {
      const brand = getBrand();
      const result = await qualifyCompany(llm, buildInput(company, evidence, getEnv().DATA_DIR), brand.offeredServices, brand.businessName);
      quals.save({ companyId: company.id, ...result, provider: llm.name, model: result.model, promptVersion: PROMPT_VERSION });
      summary.byDecision[result.decision] = (summary.byDecision[result.decision] ?? 0) + 1;
      hooks.qualified({ ...base, decision: result.decision, reason: result.decisionReason, notes: result.notes });
    } catch (err) {
      summary.failed++;
      hooks.qualified({ ...base, decision: null, reason: (err as Error).message, notes: [] });
    }
  }
  summary.totalMs = Date.now() - started;
  summary.awaitingReview = quals.counts()['needs_review'] ?? 0;
  return summary;
}

export function decide(db: Db, companyId: number, decision: Qualification, reason: string): void {
  new QualificationModel(db).decideManually(companyId, decision, reason);
}

function buildInput(company: Company, evidence: EvidenceModel, dataDir: string): CompanyInput {
  const pages = loadPageTexts(evidence, company.id, dataDir);
  const contacts = evidence.contactsFor(company.id);
  if (pages.length === 0 && !contacts.some((c) => c.method === 'manual')) {
    throw new Error('no readable page snapshots; re-crawl this company');
  }
  return { name: company.name, domain: company.domain, address: company.address, contacts, pages };
}
