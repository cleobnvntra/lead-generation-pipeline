import { join } from 'node:path';
import { confirm, input, search, select, Separator } from '@inquirer/prompts';
import pc from 'picocolors';
import { getEnv } from '../config/env.ts';
import { addCompany, getCompanyDetails, listLeads, searchCompanies } from '../controllers/companyController.ts';
import { addManualContact } from '../controllers/contactController.ts';
import { crawl } from '../controllers/crawlController.ts';
import { decide, qualify } from '../controllers/qualifyController.ts';
import type { Db } from '../db/connection.ts';
import { normalizeWebsiteUrl } from '../lib/domain.ts';
import { openExternal } from '../lib/openExternal.ts';
import type { Company, CompanyStatus, Qualification } from '../models/types.ts';
import { cleanEmail } from '../services/crawler/extract.ts';
import { createLlmProvider } from '../services/llm/index.ts';
import { renderCompanyCard } from '../views/companyCard.ts';
import { friendlyHooks } from '../views/friendlyHooks.ts';
import { QUALIFICATION_LABEL, STATUS_LABEL } from '../views/labels.ts';
import { dim, info, newPage, ok, qualificationBadge, statusBadge, table, title, truncate, warn } from '../views/ui.ts';
import { explainError, pause } from './prompts.ts';
import { showDraft } from './drafts.ts';
import { DraftModel } from '../models/draftModel.ts';

const nameOf = (c: Company) => c.name ?? c.domain;

/** Profile + actions for one company. Returns when the user goes back. */
export async function companyScreen(db: Db, companyId: number): Promise<void> {
  let flash: string | null = null; // result of the last action, shown on the redrawn page
  for (;;) {
    newPage(flash);
    flash = null;
    const d = getCompanyDetails(db, companyId);
    console.log(renderCompanyCard(d, getEnv().DATA_DIR));
    const c = d.company;
    const draft = new DraftModel(db).forCompany(c.id);
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Open their website', value: 'site' },
        { name: 'Open the folder of saved pages', value: 'folder', disabled: d.pages.some((p) => p.snapshot_path) ? false : '(none saved)' },
        { name: 'Add an email I found on their website', value: 'email', disabled: c.status === 'opted_out' ? '(site refuses email)' : false },
        { name: 'Change the decision', value: 'decide' },
        { name: 'View the email draft', value: 'draft', disabled: draft ? false : '(no draft yet)' },
        new Separator(),
        { name: '← Back', value: 'back' },
      ],
    });
    try {
      if (action === 'back') return;
      if (action === 'site') {
        openExternal(c.website_url);
        flash = ok('Opened their website in your browser.');
      }
      if (action === 'folder') {
        const folder = join(getEnv().DATA_DIR, 'snapshots', String(c.id));
        openExternal(folder);
        flash = ok(`Opened ${folder}`);
      }
      if (action === 'email') flash = (await addEmailFlow(db, c)).message;
      if (action === 'decide') flash = await decisionFlow(db, c);
      if (action === 'draft' && draft) await showDraft(db, draft.id);
    } catch (err) {
      flash = explainError(err);
    }
  }
}

/**
 * Asks for an email + the page it was on; saves it with the same checks as the crawler.
 * Returns a message for the caller to show (null if cancelled).
 */
export async function addEmailFlow(db: Db, c: Company): Promise<{ created: boolean; message: string | null }> {
  console.log(dim(`\n  Only add an email that is published on ${c.domain} itself.`));
  const email = await input({
    message: 'Email address (leave empty to cancel):',
    validate: (v) => !v.trim() || cleanEmail(v) !== null || 'Not a usable address (typo, placeholder, or a mailbox like careers@ / privacy@)',
  });
  if (!email.trim()) return { created: false, message: null };
  const source = await input({
    message: 'Web address of the page where you saw it:',
    default: c.website_url,
    validate: (v) => {
      try {
        normalizeWebsiteUrl(v);
        return true;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });
  const note = await input({ message: 'Note (optional, e.g. "in the page footer"):' });
  const res = addManualContact(db, { companyId: c.id, email, sourceUrl: source, ...(note.trim() ? { note } : {}) });
  const message = !res.created
    ? info('That email was already saved.')
    : res.verdictCleared
      ? ok('Email saved. The AI will look at this company again next time it runs.')
      : ok('Email saved.');
  return { created: res.created, message };
}

/** Manual decision with a short reason (pre-filled so it's one Enter for the common case). Returns a message, or null if cancelled. */
export async function decisionFlow(db: Db, c: Company, preset?: Qualification): Promise<string | null> {
  const decision =
    preset ??
    (await select<Qualification | 'cancel'>({
      message: `Decision for ${nameOf(c)}:`,
      choices: [
        { name: `${QUALIFICATION_LABEL.qualified} — I want to email them`, value: 'qualified' },
        { name: `${QUALIFICATION_LABEL.disqualified} — don't email them`, value: 'disqualified' },
        { name: `${QUALIFICATION_LABEL.needs_review} — decide later`, value: 'needs_review' },
        new Separator(),
        { name: '← Cancel', value: 'cancel' },
      ],
    }));
  if (decision === 'cancel') return null;
  const defaults: Record<Qualification, string> = {
    qualified: 'Checked their website myself',
    disqualified: 'Not a fit',
    needs_review: 'Decide later',
  };
  const reason = await input({
    message: 'Reason (press Enter to keep):',
    default: defaults[decision],
    validate: (v) => (v.trim().length >= 3 && v.trim().length <= 300) || 'Please write 3-300 characters',
  });
  decide(db, c.id, decision, reason);
  return ok(`${nameOf(c)}: ${QUALIFICATION_LABEL[decision]}.`);
}

export async function lookupFlow(db: Db): Promise<void> {
  const id = await search<number | null>({
    message: 'Type part of a company name or website:',
    source: (term) => {
      const results = searchCompanies(db, term ?? '', 15).map((c) => ({
        name: `${truncate(nameOf(c), 45)}  ${dim(c.domain)}`,
        value: c.id as number | null,
        description: `${STATUS_LABEL[c.status]} · ${QUALIFICATION_LABEL[c.qualification ?? 'none']}`,
      }));
      return [...results, { name: '← Back', value: null, description: '' }];
    },
  });
  if (id !== null) await companyScreen(db, id);
}

type BrowseFilter = 'qualified' | 'needs_review' | 'disqualified' | 'problems' | 'all';

export async function browseFlow(db: Db): Promise<void> {
  const filter = await select<BrowseFilter | 'back'>({
    message: 'Which companies?',
    choices: [
      { name: QUALIFICATION_LABEL.qualified, value: 'qualified' },
      { name: QUALIFICATION_LABEL.needs_review, value: 'needs_review' },
      { name: QUALIFICATION_LABEL.disqualified, value: 'disqualified' },
      { name: 'Website problems (no email found / couldn\'t be checked)', value: 'problems' },
      { name: 'All companies', value: 'all' },
      new Separator(),
      { name: '← Back', value: 'back' },
    ],
  });
  if (filter === 'back') return;

  const rows =
    filter === 'problems'
      ? (['no_contacts', 'crawl_failed', 'opted_out'] as CompanyStatus[]).flatMap((status) => listLeads(db, { status }, 500))
      : filter === 'all'
        ? listLeads(db, {}, 500)
        : listLeads(db, { qualification: filter }, 500);

  newPage();
  console.log(title(`${rows.length} compan${rows.length === 1 ? 'y' : 'ies'}`));
  if (rows.length === 0) {
    await pause();
    return;
  }
  console.log(
    table(rows, [
      { header: '#', get: (r) => String(r.company.id), min: 4 },
      { header: 'Company', get: (r) => nameOf(r.company), flex: 3, min: 16 },
      { header: 'Best contact', get: (r) => r.qualification?.best_contact_email ?? r.contacts[0]?.email ?? dim('—'), flex: 3, min: 16 },
      {
        header: 'Status',
        get: (r) => (filter === 'problems' ? statusBadge(r.company.status) : qualificationBadge(r.company.qualification)),
        flex: 2,
        min: 16,
      },
    ]),
  );

  const id = await select<number | null>({
    message: 'Open a company?',
    choices: [{ name: '← Back', value: null }, ...rows.map((r) => ({ name: `#${r.company.id}  ${nameOf(r.company)}`, value: r.company.id }))],
    pageSize: 15,
  });
  if (id !== null) await companyScreen(db, id);
}

export async function addByHandFlow(db: Db): Promise<void> {
  const what = await select({
    message: 'What do you want to add?',
    choices: [
      { name: 'A company (by its website)', value: 'company' },
      { name: 'An email for a company already in the list', value: 'email' },
      new Separator(),
      { name: '← Back', value: 'back' },
    ],
  });
  if (what === 'back') return;

  if (what === 'email') {
    const id = await search<number | null>({
      message: 'Which company? Type part of the name or website:',
      source: (term) => [
        ...searchCompanies(db, term ?? '', 15).map((c) => ({ name: `${nameOf(c)}  ${dim(c.domain)}`, value: c.id as number | null })),
        { name: '← Back', value: null },
      ],
    });
    if (id === null) return;
    const c = getCompanyDetails(db, id).company;
    const res = await addEmailFlow(db, c);
    if (res.message) console.log(res.message);
    if (res.created) await offerAiReview(db);
    await pause();
    return;
  }

  const website = await input({
    message: 'Company website (e.g. acmepm.ca):',
    validate: (v) => {
      try {
        normalizeWebsiteUrl(v);
        return true;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });
  const name = await input({ message: 'Company name (optional):' });
  const res = addCompany(db, website, name.trim() || undefined);
  if (!res.created) {
    console.log(warn(`Already in the list (#${res.id}).`));
    await pause();
    return;
  }
  console.log(ok(`Added as #${res.id}.`));
  if (await confirm({ message: 'Check its website for an email now?', default: true })) {
    await crawl(db, { limit: 1000, retryFailed: false, onlyIds: [res.id] }, friendlyHooks());
    await offerAiReview(db);
  }
  await pause();
}

async function offerAiReview(db: Db): Promise<void> {
  if (!(await confirm({ message: 'Let the AI review it now?', default: true }))) return;
  try {
    await qualify(db, createLlmProvider(), { limit: 1000, redo: false }, friendlyHooks());
  } catch (err) {
    console.log(explainError(err));
  }
}

export function companyLabel(c: Company): string {
  return `${nameOf(c)} ${pc.dim(`(${c.domain})`)}`;
}
