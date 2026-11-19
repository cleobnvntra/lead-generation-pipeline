import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { addCompany, getCompanyDetails, listLeads, statusCounts } from './controllers/companyController.ts';
import { addManualContact } from './controllers/contactController.ts';
import { crawl } from './controllers/crawlController.ts';
import { discover } from './controllers/discoverController.ts';
import { findLeads } from './controllers/pipelineController.ts';
import { decide, qualify } from './controllers/qualifyController.ts';
import { getEnv } from './config/env.ts';
import { closeDb, getDb } from './db/connection.ts';
import { ConfigError, ExternalApiError, LimitError, ValidationError } from './lib/errors.ts';
import { COMPANY_STATUSES, QUALIFICATIONS, type CompanyStatus, type Qualification } from './models/types.ts';
import { createLlmProvider } from './services/llm/index.ts';
import { PlacesUsageModel } from './models/placesUsageModel.ts';
import { renderCrawl, renderDiscover, renderLeads, renderQualify, renderStats, writeLeadsCsv } from './views/cliView.ts';
import { renderCompanyCard } from './views/companyCard.ts';
import { renderDraft } from './views/draftView.ts';
import { connectGmail, disconnectGmail, gmailStatus, sendTestEmails } from './controllers/sendController.ts';
import { SendModel } from './models/sendModel.ts';
import { openExternal } from './lib/openExternal.ts';
import { approveDraft, checkDraft, rejectDraft, resetDraft, writeDrafts } from './controllers/draftController.ts';
import { DRAFT_STATUSES, DraftModel, type DraftStatus } from './models/draftModel.ts';

const USAGE = `Usage:
  npm start                                  Open the interactive menu (recommended)
  npm run cli -- <command> [options]         Run one command directly

Commands:
  run --city <city> [--pages 1-3]            Discover + crawl + qualify in one step
  review                                     Go through companies that need a decision
  show <id>                                  Everything about one company
  draft [--limit 25] [--redo]                Write email drafts for ready companies (never sends)
  drafts [--status <s>] [--show <id>]        List drafts, or show one in full
  drafts approve|reject|undo|check <id>      Approve (after checks), reject (--reason), undo, or just check
  gmail connect|status|disconnect            Sign in as EMAIL_FROM for test sending (send-only permission)
  send-test [--id <draftId>] [--limit 5]     Send approved drafts ONLY to TEST_RECIPIENT (--resend to repeat)
  sends [--limit 50]                         Log of test sends
  add <website> [--name "Acme PM"]           Seed a company manually (no API key needed)
  discover --city <city> [--query <text>]    Find property managers via Google Places
           [--pages 1-3] [--force]           ({city} in --query is substituted)
  crawl [--limit 25] [--retry-failed]        Crawl pending companies for published contacts
        [--retry-no-contacts]                (JavaScript-built sites are retried in headless Chromium)
  qualify [--limit 25] [--redo]              Classify crawled companies with the local LLM
                                             (--redo re-runs LLM verdicts; manual ones are kept)
  decide <id> <qualification> --reason "..." Manually set a company's qualification
  contact add <id> <email> --source <url>    Add an email you found on the company's site yourself
          [--note "..."] [--snapshot <file>] (--snapshot: page saved with Ctrl+S, as evidence)
  leads [--status <s>] [--qualification <q>] List companies, verdicts and contacts with sources
        [--limit 50] [--csv <file>]          ...or export them to CSV
  stats                                      Counts and Places API usage

Statuses:       ${COMPANY_STATUSES.join(', ')}
Qualifications: ${QUALIFICATIONS.join(', ')}`;

function int(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new ValidationError(`--${name} must be a positive integer, got "${value}"`);
  return Number(value);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === 'menu') {
    const { runMenu } = await import('./menu/index.ts');
    await runMenu(getDb());
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      name: { type: 'string' },
      city: { type: 'string' },
      query: { type: 'string' },
      pages: { type: 'string' },
      force: { type: 'boolean', default: false },
      limit: { type: 'string' },
      'retry-failed': { type: 'boolean', default: false },
      'retry-no-contacts': { type: 'boolean', default: false },
      status: { type: 'string' },
      csv: { type: 'string' },
      qualification: { type: 'string' },
      redo: { type: 'boolean', default: false },
      reason: { type: 'string' },
      source: { type: 'string' },
      note: { type: 'string' },
      snapshot: { type: 'string' },
      show: { type: 'string' },
      id: { type: 'string' },
      resend: { type: 'boolean', default: false },
    },
  });

  const db = getDb();
  switch (command) {
    case 'add': {
      if (positionals.length !== 1) throw new ValidationError('add takes exactly one website, e.g. add acmepm.ca');
      const res = addCompany(db, positionals[0]!, values.name);
      console.log(res.created ? `Added company #${res.id}.` : `Not added: ${res.reason} (#${res.id}).`);
      break;
    }
    case 'run': {
      if (!values.city) throw new ValidationError('run requires --city, e.g. --city "Toronto"');
      const res = await findLeads(db, createLlmProvider(), {
        city: values.city,
        ...(values.query !== undefined ? { query: values.query } : {}),
        pages: int(values.pages, 'pages', 1),
        force: values.force ?? false,
      });
      console.log([renderDiscover(res.discover), renderCrawl(res.crawl), renderQualify(res.qualify)].join('\n'));
      break;
    }
    case 'review': {
      const { reviewFlow } = await import('./menu/review.ts');
      const { isExitPrompt } = await import('./menu/prompts.ts');
      try {
        await reviewFlow(db);
      } catch (err) {
        if (!isExitPrompt(err)) throw err;
      }
      break;
    }
    case 'show': {
      if (positionals.length !== 1) throw new ValidationError('Usage: show <companyId>');
      console.log(renderCompanyCard(getCompanyDetails(db, int(positionals[0], 'companyId', 0)), getEnv().DATA_DIR));
      break;
    }
    case 'draft': {
      const res = await writeDrafts(db, createLlmProvider(), { limit: int(values.limit, 'limit', 25), redo: values.redo ?? false });
      console.log(`Drafted ${res.drafted} of ${res.companies} (${res.aiOpeners} with AI opening line, ${res.skipped} skipped). Nothing was sent.`);
      break;
    }
    case 'gmail': {
      const action = positionals[0];
      if (action === 'connect') {
        console.log('Opening your browser to sign in to Google. If it does not open, copy the link printed below.');
        const email = await connectGmail((url) => {
          console.log(`\n${url}\n\nWaiting for you to finish signing in (up to 5 minutes; Ctrl+C to cancel)...`);
          try {
            openExternal(url);
          } catch {
            /* link printed above */
          }
        });
        console.log(`Gmail connected as ${email}. Test emails can now be sent.`);
      } else if (action === 'status') {
        const s = gmailStatus();
        console.log(`Sign-in file: ${s.clientFile ? 'found' : 'missing (data/google-oauth-client.json)'}`);
        console.log(`Connected as: ${s.connectedAs ?? 'not connected'}${s.expected && s.connectedAs && s.connectedAs !== s.expected ? ` (EMAIL_FROM is ${s.expected}!)` : ''}`);
      } else if (action === 'disconnect') {
        console.log(disconnectGmail() ? 'Disconnected (token deleted).' : 'Was not connected.');
      } else {
        throw new ValidationError('Usage: gmail connect | status | disconnect');
      }
      break;
    }
    case 'send-test': {
      const res = await sendTestEmails(db, {
        ...(values.id !== undefined ? { draftIds: [int(values.id, 'id', 0)] } : {}),
        limit: int(values.limit, 'limit', 5),
        resend: values.resend ?? false,
      });
      console.log(`Test emails: ${res.sent} sent, ${res.failed} failed, ${res.blocked} blocked by checks. ${res.remainingToday} left today. Nothing was sent to any company.`);
      break;
    }
    case 'sends': {
      for (const s of new SendModel(db).list(int(values.limit, 'limit', 50))) {
        console.log(`${s.created_at.slice(0, 16).replace('T', ' ')}  ${s.status.padEnd(7)}  to ${s.sent_to}  (written for ${s.intended_to})  ${s.error ?? ''}`);
      }
      break;
    }
    case 'drafts': {
      const model = new DraftModel(db);
      const [action, idArg] = positionals;
      if (action !== undefined) {
        if (!['approve', 'reject', 'undo', 'check'].includes(action) || positionals.length !== 2) {
          throw new ValidationError('Usage: drafts approve|reject|undo|check <draftId> [--reason "..."]');
        }
        const id = int(idArg, 'draftId', 0);
        if (action === 'approve') {
          const { warnings } = approveDraft(db, id);
          console.log(`Draft #${id} approved.${warnings.map((w) => `\n  Note: ${w}`).join('')}`);
        } else if (action === 'reject') {
          if (!values.reason) throw new ValidationError('drafts reject requires --reason "..."');
          rejectDraft(db, id, values.reason);
          console.log(`Draft #${id} rejected.`);
        } else if (action === 'undo') {
          resetDraft(db, id);
          console.log(`Draft #${id} is waiting for approval again.`);
        } else {
          const c = checkDraft(db, id);
          console.log(c.problems.length ? `Can't approve:\n${c.problems.map((p) => `  - ${p}`).join('\n')}` : 'OK to approve.');
          for (const w of c.warnings) console.log(`  Note: ${w}`);
        }
        break;
      }
      if (values.show !== undefined) {
        const id = int(values.show, 'show', 0);
        const d = model.list(undefined, 10_000).find((x) => x.id === id);
        if (!d) throw new ValidationError(`Draft #${id} not found`);
        console.log(renderDraft(d, getEnv().TEST_RECIPIENT));
        break;
      }
      const status = values.status as DraftStatus | undefined;
      if (status !== undefined && !DRAFT_STATUSES.includes(status)) throw new ValidationError(`--status must be one of: ${DRAFT_STATUSES.join(', ')}`);
      for (const d of model.list(status, int(values.limit, 'limit', 100))) {
        console.log(`#${d.id}  ${d.status.padEnd(8)}  ${(d.company_name ?? d.domain).padEnd(40).slice(0, 40)}  ${d.subject}`);
      }
      break;
    }
    case 'discover': {
      if (!values.city) throw new ValidationError('discover requires --city, e.g. --city "Toronto"');
      const summary = await discover(db, {
        city: values.city,
        ...(values.query !== undefined ? { query: values.query } : {}),
        pages: int(values.pages, 'pages', 3),
        force: values.force ?? false,
      });
      console.log(renderDiscover(summary));
      break;
    }
    case 'crawl': {
      const summary = await crawl(db, {
        limit: int(values.limit, 'limit', 25),
        retryFailed: values['retry-failed'] ?? false,
        retryNoContacts: values['retry-no-contacts'] ?? false,
      });
      console.log(renderCrawl(summary));
      break;
    }
    case 'qualify': {
      const summary = await qualify(db, createLlmProvider(), { limit: int(values.limit, 'limit', 25), redo: values.redo ?? false });
      console.log(renderQualify(summary));
      break;
    }
    case 'decide': {
      if (positionals.length !== 2) throw new ValidationError('Usage: decide <companyId> <qualification> --reason "..."');
      const id = int(positionals[0], 'companyId', 0);
      const decision = positionals[1] as Qualification;
      if (!QUALIFICATIONS.includes(decision)) throw new ValidationError(`qualification must be one of: ${QUALIFICATIONS.join(', ')}`);
      if (!values.reason) throw new ValidationError('decide requires --reason "..."');
      decide(db, id, decision, values.reason);
      console.log(`Company #${id} set to ${decision} (manual).`);
      break;
    }
    case 'contact': {
      if (positionals[0] !== 'add' || positionals.length !== 3) {
        throw new ValidationError('Usage: contact add <companyId> <email> --source <url> [--note "..."] [--snapshot <file>]');
      }
      if (!values.source) throw new ValidationError('contact add requires --source <url of the page showing the email>');
      const res = addManualContact(db, {
        companyId: int(positionals[1], 'companyId', 0),
        email: positionals[2]!,
        sourceUrl: values.source,
        ...(values.note !== undefined ? { note: values.note } : {}),
        ...(values.snapshot !== undefined ? { snapshotFile: resolve(values.snapshot) } : {}),
      });
      if (!res.created) console.log(`Contact already existed (#${res.contactId}); source/note recorded.`);
      else if (res.manualVerdictKept) console.log(`Added contact #${res.contactId}. Your manual verdict is kept; use "decide" to change it.`);
      else if (res.verdictCleared) console.log(`Added contact #${res.contactId}. Previous model verdict cleared; run qualify to re-check.`);
      else console.log(`Added contact #${res.contactId}. Company is now eligible for qualify.`);
      break;
    }
    case 'leads': {
      const status = values.status as CompanyStatus | undefined;
      if (status !== undefined && !COMPANY_STATUSES.includes(status)) {
        throw new ValidationError(`--status must be one of: ${COMPANY_STATUSES.join(', ')}`);
      }
      const qualification = values.qualification as Qualification | undefined;
      if (qualification !== undefined && !QUALIFICATIONS.includes(qualification)) {
        throw new ValidationError(`--qualification must be one of: ${QUALIFICATIONS.join(', ')}`);
      }
      const rows = listLeads(
        db,
        { ...(status ? { status } : {}), ...(qualification ? { qualification } : {}) },
        int(values.limit, 'limit', 50),
      );
      if (values.csv) {
        const path = resolve(values.csv);
        if (!path.toLowerCase().endsWith('.csv')) throw new ValidationError('--csv path must end in .csv');
        const n = writeLeadsCsv(rows, path);
        console.log(`Wrote ${rows.length} companies / ${n} contacts to ${path}`);
      } else {
        console.log(renderLeads(rows));
      }
      break;
    }
    case 'stats': {
      const usage = new PlacesUsageModel(db);
      console.log(renderStats(statusCounts(db), { last24h: usage.countLast24h(), month: usage.countThisMonth() }));
      break;
    }
    default:
      throw new ValidationError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2))
  .catch((err: unknown) => {
    const known = [ConfigError, ValidationError, LimitError, ExternalApiError].some((E) => err instanceof E);
    const parseError = err instanceof TypeError && (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    console.error(known || parseError ? `Error: ${(err as Error).message}` : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
