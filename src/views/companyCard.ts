import { join } from 'node:path';
import pc from 'picocolors';
import type { CompanyDetails } from '../controllers/companyController.ts';
import { CONTACT_KIND_LABEL, describeCrawlReason, labelList, METHOD_LABEL, SEGMENT_LABEL, SERVICE_LABEL } from './labels.ts';
import { keyValues, qualificationBadge, sectionHeading, statusBadge, title, truncate, width } from './ui.ts';

/** Full, readable profile of one company. `dataDir` turns snapshot paths into openable files. */
export function renderCompanyCard(d: CompanyDetails, dataDir: string): string {
  const c = d.company;
  const latest = d.history[0];
  const out: string[] = [title(`#${c.id}  ${c.name ?? c.domain}`)];

  const statusReason = describeCrawlReason(c.status_reason);
  const decisionWho = c.qualification_source === 'manual' ? 'decided by you' : c.qualification_source === 'llm' ? 'suggested by AI' : null;
  out.push(
    keyValues([
      ['Website', c.website_url],
      ['Address', c.address],
      ['Phone', c.phone],
      ['Website check', `${statusBadge(c.status)}${statusReason ? pc.dim(` — ${statusReason}`) : ''}`],
      ['Decision', `${qualificationBadge(c.qualification)}${decisionWho ? pc.dim(` (${decisionWho})`) : ''}`],
      ['Why', c.qualification_reason ? labelReason(c.qualification_reason) : null],
    ]),
  );

  if (latest) {
    out.push(sectionHeading('What the AI found'));
    const segments = JSON.parse(latest.segments) as string[];
    const services = JSON.parse(latest.services_fit) as string[];
    const who = [latest.contact_name, latest.contact_title].filter(Boolean).join(', ');
    out.push(
      keyValues([
        ['About them', latest.summary],
        ['They manage', segments.length ? labelList(segments, SEGMENT_LABEL) : null],
        ['Our services', services.length ? labelList(services, SERVICE_LABEL) : null],
        ['Best contact', latest.best_contact_email ? `${latest.best_contact_email}${who ? ` (${who})` : ''}` : null],
        ['Checked', `${latest.created_at.slice(0, 10)} with ${latest.model}`],
      ]),
    );
    if (latest.notes) out.push(pc.dim(`  Safety checks corrected the AI: ${latest.notes}`));
  }

  out.push(sectionHeading(`Emails found (${d.contacts.length})`));
  if (d.contacts.length === 0) out.push(pc.dim('  None yet.'));
  const max = width() - 8;
  for (const [i, k] of d.contacts.entries()) {
    const best = latest?.best_contact_email === k.email ? pc.green(' ★ best') : '';
    const domain = k.on_company_domain ? 'company domain' : pc.yellow('other domain');
    out.push(`  ${i + 1}. ${pc.bold(k.email)}${best}  ${pc.dim(`${CONTACT_KIND_LABEL[k.kind]} · ${domain} · ${METHOD_LABEL[k.method]}`)}`);
    out.push(pc.dim(`     found on ${truncate(k.source_url, max)}`));
  }

  if (d.optOuts.length) {
    out.push(sectionHeading(pc.magenta('Website says no unsolicited email')));
    for (const o of d.optOuts) out.push(pc.dim(`  "${truncate(o.context, max)}"  — ${o.url}`));
  }

  out.push(sectionHeading(`Saved pages (${d.pages.length})`));
  if (d.pages.length === 0) out.push(pc.dim('  None.'));
  for (const p of d.pages.slice(0, 12)) {
    const how = p.capture === 'manual' ? 'noted by you' : p.note ? p.note : 'saved copy';
    out.push(`  ${pc.dim('•')} ${truncate(p.final_url, max - 30)}  ${pc.dim(`${p.fetched_at.slice(0, 10)} · ${how}`)}`);
    if (p.snapshot_path) out.push(pc.dim(`     ${join(dataDir, p.snapshot_path)}`));
  }
  if (d.pages.length > 12) out.push(pc.dim(`  …and ${d.pages.length - 12} more`));
  return out.join('\n');
}

function labelReason(reason: string): string {
  return reason.replace(/^fits: (.*)$/, (_, list: string) => `fits: ${labelList(list.split(', '), SERVICE_LABEL)}`);
}
