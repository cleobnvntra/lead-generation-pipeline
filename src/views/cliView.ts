import { writeFileSync } from 'node:fs';
import type { LeadRow } from '../controllers/companyController.ts';
import type { CrawlSummary } from '../controllers/crawlController.ts';
import type { DiscoverSummary } from '../controllers/discoverController.ts';
import type { QualifySummary } from '../controllers/qualifyController.ts';

export function renderDiscover(s: DiscoverSummary): string {
  if (s.skippedByCache) return `Skipped "${s.query}" (cached). No API requests made.`;
  const skipped = Object.entries(s.skipped)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  return [
    `Query:        ${s.query}`,
    `API requests: ${s.requests}`,
    `Places seen:  ${s.placesSeen}`,
    `Added:        ${s.added}`,
    `Duplicates:   ${s.duplicates}`,
    `Skipped:      ${skipped || 'none'}`,
  ].join('\n');
}

export function renderCrawl(s: CrawlSummary): string {
  const by = Object.entries(s.byStatus)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  const browser = s.browserRetries ? `; ${s.browserRetries} retried in headless browser` : '';
  return `Crawled ${s.companies} compan${s.companies === 1 ? 'y' : 'ies'} (${by || 'none'}); ${s.contactsAdded} new contact(s)${browser}.`;
}

export function renderQualify(s: QualifySummary): string {
  const by = Object.entries(s.byDecision)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  const avg = s.companies ? Math.round(s.totalMs / s.companies / 100) / 10 : 0;
  const lines = [
    s.companies === 0
      ? 'No new companies to qualify (qualify only checks companies without a verdict).'
      : `Qualified ${s.companies} compan${s.companies === 1 ? 'y' : 'ies'} (${by || 'none'}${s.failed ? `, failed: ${s.failed}` : ''}); avg ${avg}s each.`,
  ];
  if (s.awaitingReview > 0) {
    lines.push(
      `${s.awaitingReview} compan${s.awaitingReview === 1 ? 'y is' : 'ies are'} waiting for your review: npm run cli -- leads --qualification needs_review`,
      'Confirm each with: npm run cli -- decide <id> qualified|disqualified --reason "..."',
    );
  }
  return lines.join('\n');
}

export function renderStats(
  counts: { status: Record<string, number>; qualification: Record<string, number> },
  usage: { last24h: number; month: number },
): string {
  const fmt = (r: Record<string, number>) => {
    const lines = Object.entries(r).map(([k, v]) => `  ${k.padEnd(13)} ${v}`);
    return lines.length ? lines : ['  (none)'];
  };
  return [
    'Companies by crawl status:',
    ...fmt(counts.status),
    'Crawled companies by qualification:',
    ...fmt(counts.qualification),
    `Places requests: ${usage.last24h} in last 24h, ${usage.month} this month`,
  ].join('\n');
}

export function renderLeads(rows: LeadRow[]): string {
  if (rows.length === 0) return 'No companies match.';
  const out: string[] = [];
  for (const { company: c, contacts, qualification: q } of rows) {
    out.push(`#${c.id} ${c.name ?? '(no name)'} — ${c.domain} [${c.status}${c.status_reason ? `: ${c.status_reason}` : ''}]`);
    if (c.qualification) {
      out.push(`    qualification: ${c.qualification} (${c.qualification_source}) — ${c.qualification_reason ?? ''}`);
    }
    if (q) {
      out.push(`    segments: ${JSON.parse(q.segments).join(', ') || '-'} | services: ${JSON.parse(q.services_fit).join(', ') || '-'}`);
      out.push(`    summary: ${q.summary}`);
      const who = [q.contact_name, q.contact_title].filter(Boolean).join(', ');
      if (q.best_contact_email) out.push(`    best contact: ${q.best_contact_email}${who ? ` (${who})` : ''}`);
      if (q.notes) out.push(`    guardrails: ${q.notes}`);
    }
    for (const k of contacts) {
      const flags = [k.kind, k.on_company_domain ? 'own-domain' : 'external-domain', k.method].join(', ');
      out.push(`    ${k.email}  (${flags})  source: ${k.source_url}`);
    }
  }
  return out.join('\n');
}

const CSV_HEADER = [
  'company_id',
  'company',
  'domain',
  'status',
  'qualification',
  'qualification_reason',
  'segments',
  'services_fit',
  'summary',
  'best_contact',
  'contact_name',
  'contact_title',
  'address',
  'phone',
  'email',
  'kind',
  'on_company_domain',
  'source_url',
  'context',
];

export function writeLeadsCsv(rows: LeadRow[], path: string): number {
  const lines = [CSV_HEADER.join(',')];
  let n = 0;
  for (const { company: c, contacts, qualification: q } of rows) {
    const base = [
      c.id,
      c.name,
      c.domain,
      c.status,
      c.qualification,
      c.qualification_reason,
      q ? JSON.parse(q.segments).join(' ') : '',
      q ? JSON.parse(q.services_fit).join(' ') : '',
      q?.summary,
      q?.best_contact_email,
      q?.contact_name,
      q?.contact_title,
      c.address,
      c.phone,
    ];
    if (contacts.length === 0) {
      lines.push(csvRow([...base, '', '', '', '', '']));
      continue;
    }
    for (const k of contacts) {
      lines.push(csvRow([...base, k.email, k.kind, k.on_company_domain, k.source_url, k.context]));
      n++;
    }
  }
  writeFileSync(path, `﻿${lines.join('\r\n')}\r\n`, 'utf8'); // BOM so Excel reads UTF-8
  return n;
}

function csvRow(values: unknown[]): string {
  return values
    .map((v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralize spreadsheet formula injection
      return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    })
    .join(',');
}
