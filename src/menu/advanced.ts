import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { confirm, select, Separator } from '@inquirer/prompts';
import { getEnv } from '../config/env.ts';
import { listLeads, statusCounts } from '../controllers/companyController.ts';
import { crawl } from '../controllers/crawlController.ts';
import { qualify } from '../controllers/qualifyController.ts';
import type { Db } from '../db/connection.ts';
import { openExternal } from '../lib/openExternal.ts';
import { PlacesUsageModel } from '../models/placesUsageModel.ts';
import { createLlmProvider } from '../services/llm/index.ts';
import { writeLeadsCsv } from '../views/cliView.ts';
import { friendlyHooks } from '../views/friendlyHooks.ts';
import { QUALIFICATION_LABEL, STATUS_LABEL } from '../views/labels.ts';
import { dim, keyValues, newPage, ok, sectionHeading, title } from '../views/ui.ts';
import { pause } from './prompts.ts';
import { gmailFlow } from './sending.ts';

export async function overviewFlow(db: Db): Promise<void> {
  const env = getEnv();
  const counts = statusCounts(db);
  const usage = new PlacesUsageModel(db);
  console.log(title('Overview'));
  console.log(sectionHeading('Leads'));
  console.log(
    keyValues(
      (['qualified', 'needs_review', 'disqualified'] as const).map((q) => [QUALIFICATION_LABEL[q], String(counts.qualification[q] ?? 0)]),
    ),
  );
  console.log(sectionHeading('Websites'));
  console.log(
    keyValues((['crawled', 'new', 'no_contacts', 'crawl_failed', 'opted_out'] as const).map((s) => [STATUS_LABEL[s], String(counts.status[s] ?? 0)])),
  );
  console.log(sectionHeading('Google searches (free limit)'));
  console.log(
    keyValues([
      ['Last 24 hours', `${usage.countLast24h()} of ${env.PLACES_MAX_REQUESTS_PER_DAY}`],
      ['This month', `${usage.countThisMonth()} of ${env.PLACES_MAX_REQUESTS_PER_MONTH}`],
    ]),
  );
  await pause();
}

export async function advancedFlow(db: Db): Promise<void> {
  for (;;) {
    newPage();
    console.log(title('More tools'));
    const action = await select({
      message: 'Choose a tool:',
      choices: [
        { name: 'Check websites that were added but not checked yet', value: 'crawl' },
        { name: "Try again: websites that couldn't be checked or had no email", value: 'retry' },
        { name: 'Let the AI review companies it has not seen yet', value: 'qualify' },
        { name: 'Let the AI re-review everything (keeps your own decisions)', value: 'redo' },
        { name: 'Save all leads to a spreadsheet (CSV)', value: 'csv' },
        { name: 'Gmail connection and test email log', value: 'gmail' },
        new Separator(),
        { name: '← Back', value: 'back' },
      ],
    });
    if (action === 'back') return;
    if (action === 'gmail') {
      await gmailFlow(db);
      continue;
    }
    if (action === 'crawl') await crawl(db, { limit: 1000, retryFailed: false }, friendlyHooks());
    if (action === 'retry') await crawl(db, { limit: 1000, retryFailed: true, retryNoContacts: true }, friendlyHooks());
    if (action === 'qualify') await qualify(db, createLlmProvider(), { limit: 1000, redo: false }, friendlyHooks());
    if (action === 'redo') {
      console.log(dim('  This re-checks every company the AI decided before. Your own decisions are kept.'));
      if (await confirm({ message: 'Continue?', default: false })) {
        await qualify(db, createLlmProvider(), { limit: 1000, redo: true }, friendlyHooks());
      }
    }
    if (action === 'csv') {
      const dir = join(getEnv().DATA_DIR, 'exports');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `leads-${new Date().toISOString().slice(0, 10)}.csv`);
      const rows = listLeads(db, {}, 100_000);
      const n = writeLeadsCsv(rows, file);
      console.log(ok(`Saved ${rows.length} companies and ${n} emails to:`));
      console.log(`  ${file}`);
      if (await confirm({ message: 'Open the folder?', default: true })) openExternal(dir);
    }
    await pause();
  }
}
