import pc from 'picocolors';
import type { Draft } from '../models/draftModel.ts';
import { findPlaceholders } from '../services/draft/drafter.ts';
import { keyValues, title, warn } from './ui.ts';

export const DRAFT_STATUS_LABEL: Record<Draft['status'], string> = {
  draft: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function draftStatusBadge(d: Pick<Draft, 'status'>): string {
  if (d.status === 'approved') return pc.green(`✔ ${DRAFT_STATUS_LABEL.approved}`);
  if (d.status === 'rejected') return pc.dim(`✖ ${DRAFT_STATUS_LABEL.rejected}`);
  return pc.yellow(`? ${DRAFT_STATUS_LABEL.draft}`);
}

function statusLine(d: Draft): string {
  if (d.status === 'approved' && d.approved_at) return `${draftStatusBadge(d)} ${pc.dim(`on ${d.approved_at.slice(0, 16).replace('T', ' ')}`)}`;
  if (d.status === 'rejected') return `${draftStatusBadge(d)}${d.rejected_reason ? pc.dim(` — ${d.rejected_reason}`) : ''}`;
  return draftStatusBadge(d);
}

/** Shows a draft exactly as it would be sent, plus where test mode would actually deliver it. */
export function renderDraft(d: Draft & { company_name?: string | null; domain?: string }, testRecipient: string | undefined): string {
  const out = [title(`Email draft #${d.id}${d.company_name ? ` — ${d.company_name}` : ''}`)];
  out.push(
    keyValues([
      ['To', d.to_email],
      ['Test mode', testRecipient ? `would actually be sent to ${testRecipient} (you), not to ${d.to_email}` : pc.yellow('TEST_RECIPIENT not set in .env')],
      ['Status', statusLine(d)],
      ['Opening line', d.edited ? 'edited by you' : d.opener_source === 'llm' ? 'written by AI (checked)' : 'standard sentence'],
      ['Written', `${d.updated_at.slice(0, 16).replace('T', ' ')}${d.model ? ` with ${d.model}` : ''}`],
    ]),
  );
  out.push('', `  ${pc.dim('Subject:')} ${pc.bold(d.subject)}`, pc.dim(`  ${'─'.repeat(60)}`));
  out.push(...d.body.split('\n').map((l) => `  ${l}`));
  out.push(pc.dim(`  ${'─'.repeat(60)}`));
  const placeholders = findPlaceholders(d.body);
  if (placeholders.length) out.push(warn(`Still to fill in before real sending: ${placeholders.join(', ')} (in brand.json)`));
  if (d.notes) out.push(pc.dim(`  Safety checks: ${d.notes}`));
  return out.join('\n');
}
