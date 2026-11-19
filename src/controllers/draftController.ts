import { getBrand, type Brand } from '../config/brand.ts';
import type { Db } from '../db/connection.ts';
import { ValidationError } from '../lib/errors.ts';
import { logHooks, type ProgressHooks } from '../lib/progress.ts';
import { DraftModel, type Draft } from '../models/draftModel.ts';
import { CompanyModel } from '../models/companyModel.ts';
import { checkDraftForApproval, type ApprovalCheck } from '../services/draft/approval.ts';
import { EvidenceModel } from '../models/evidenceModel.ts';
import { QualificationModel } from '../models/qualificationModel.ts';
import type { Segment } from '../models/types.ts';
import { DRAFT_PROMPT_VERSION, draftEmail } from '../services/draft/drafter.ts';
import type { LlmProvider } from '../services/llm/types.ts';
import { rankContacts, servicesForSegments, verifySegments } from '../services/qualify/qualifier.ts';
import { loadPageTexts } from '../services/evidenceText.ts';
import { getEnv } from '../config/env.ts';

export interface DraftRunInput {
  limit: number;
  redo: boolean;
}

export interface DraftRunSummary {
  companies: number;
  drafted: number;
  aiOpeners: number;
  skipped: number;
}

/** Runs the approval rules against the draft's current company, contact and brand details. */
export function checkDraft(db: Db, draftId: number, brand: Brand = getBrand()): ApprovalCheck & { draft: Draft } {
  const draft = new DraftModel(db).require(draftId);
  const company = new CompanyModel(db).getById(draft.company_id);
  if (!company) throw new ValidationError(`Company #${draft.company_id} not found`);
  const contact = db.prepare('SELECT email FROM contacts WHERE id = ? AND company_id = ?').get(draft.contact_id, draft.company_id) as
    | { email: string }
    | undefined;
  return { draft, ...checkDraftForApproval(draft, company, contact?.email ?? null, brand) };
}

/** Approves a draft only if every rule passes. Returns warnings that are acceptable while testing. */
export function approveDraft(db: Db, draftId: number): { warnings: string[] } {
  return db.transaction(() => {
    const check = checkDraft(db, draftId);
    if (check.problems.length) {
      throw new ValidationError(`Can't approve draft #${draftId}:\n${check.problems.map((p) => `  - ${p}`).join('\n')}`);
    }
    new DraftModel(db).approve(draftId);
    return { warnings: check.warnings };
  })();
}

export function rejectDraft(db: Db, draftId: number, reason: string): void {
  new DraftModel(db).reject(draftId, reason);
}

export function resetDraft(db: Db, draftId: number): void {
  new DraftModel(db).reset(draftId);
}

/** Saves edited text. An approved draft goes back to "waiting for approval". Returns the checks for the new text. */
export function editDraft(db: Db, draftId: number, subject: string, body: string): ApprovalCheck & { draft: Draft } {
  new DraftModel(db).updateContent(draftId, subject, body);
  return checkDraft(db, draftId);
}

/** Writes (or rewrites, with redo) drafts for qualified companies. Never sends anything. */
export async function writeDrafts(db: Db, llm: LlmProvider | null, input: DraftRunInput, hooks: ProgressHooks = logHooks): Promise<DraftRunSummary> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
    throw new ValidationError('--limit must be an integer 1-1000');
  }
  const brand = getBrand();
  const drafts = new DraftModel(db);
  const quals = new QualificationModel(db);
  const evidence = new EvidenceModel(db);
  const queue = drafts.listEligible(input.limit, input.redo);
  const summary: DraftRunSummary = { companies: queue.length, drafted: 0, aiOpeners: 0, skipped: 0 };
  if (queue.length === 0) {
    hooks.step('No companies need a draft (drafts are written for companies marked "Ready to email").');
    return summary;
  }
  if (llm) await llm.healthCheck();
  hooks.step(`Writing ${queue.length} email draft(s)${llm ? ` with ${llm.model} for the opening line` : ''}...`);

  for (const [i, company] of queue.entries()) {
    const base = { done: i + 1, total: queue.length, domain: company.domain, name: company.name };
    try {
      const q = quals.latestFor(company.id);
      const contacts = evidence.contactsFor(company.id);
      const contact = contacts.find((c) => c.id === q?.best_contact_id) ?? rankContacts(contacts)[0];
      if (!contact) throw new Error('no contact');
      const useName = q?.best_contact_id === contact.id;
      // Re-check property types against the saved pages: covers older verdicts and manual decisions.
      const corpus = loadPageTexts(evidence, company.id, getEnv().DATA_DIR)
        .map((p) => p.text)
        .join(' ');
      const { kept: segments } = verifySegments(q ? (JSON.parse(q.segments) as Segment[]) : [], corpus);
      const services = servicesForSegments(segments, brand.offeredServices);
      if (services.length === 0) throw new Error('none of the offered services fit (re-run the AI review or decide by hand)');

      const out = await draftEmail(llm, brand, {
        companyName: company.name,
        domain: company.domain,
        address: company.address,
        summary: q?.summary ?? null,
        segments,
        services,
        contact: { email: contact.email, name: q && useName ? q.contact_name : null },
      });
      drafts.save({
        companyId: company.id,
        contactId: contact.id,
        toEmail: contact.email,
        subject: out.subject,
        body: out.body,
        services: out.services,
        openerSource: out.openerSource,
        notes: out.notes,
        model: out.model,
        promptVersion: DRAFT_PROMPT_VERSION,
      });
      summary.drafted++;
      if (out.openerSource === 'llm') summary.aiOpeners++;
      hooks.drafted({ ...base, subject: out.subject, aiOpener: out.openerSource === 'llm', problem: null });
    } catch (err) {
      summary.skipped++;
      hooks.drafted({ ...base, subject: null, aiOpener: false, problem: (err as Error).message });
    }
  }
  return summary;
}
