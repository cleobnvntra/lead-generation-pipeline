import { confirm, input, select } from '@inquirer/prompts';
import pc from 'picocolors';
import { getEnv } from '../config/env.ts';
import { buildQuery } from '../controllers/discoverController.ts';
import { findLeads } from '../controllers/pipelineController.ts';
import type { Db } from '../db/connection.ts';
import { PlacesUsageModel } from '../models/placesUsageModel.ts';
import { createLlmProvider } from '../services/llm/index.ts';
import { friendlyHooks } from '../views/friendlyHooks.ts';
import { bold, dim, info, keyValues, ok, title, warn } from '../views/ui.ts';
import { pause } from './prompts.ts';

export async function findLeadsFlow(db: Db): Promise<void> {
  console.log(title('Find new leads in a city'));
  console.log(
    dim('  Searches Google for property managers, checks each website for a published email,\n  then lets the AI decide which ones fit your services.'),
  );

  const env = getEnv();
  const usage = new PlacesUsageModel(db);
  const leftToday = Math.max(0, env.PLACES_MAX_REQUESTS_PER_DAY - usage.countLast24h());
  const leftMonth = Math.max(0, env.PLACES_MAX_REQUESTS_PER_MONTH - usage.countThisMonth());
  const left = Math.min(leftToday, leftMonth);
  console.log(`\n${info(`Google searches left: ${bold(String(leftToday))} today, ${bold(String(leftMonth))} this month (free limit).`)}`);
  if (left === 0) {
    console.log(warn('No searches left right now. Try again tomorrow.'));
    await pause();
    return;
  }

  const city = await input({
    message: 'Which city? (Ontario)',
    validate: (v) => {
      try {
        buildQuery(v);
        return true;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });

  const pages = await select({
    message: 'How thorough?',
    choices: [
      { name: 'Quick     — up to 20 companies (1 search)', value: 1 },
      { name: 'Normal    — up to 40 companies (2 searches)', value: 2, disabled: left < 2 ? '(not enough searches left)' : false },
      { name: 'Thorough  — up to 60 companies (3 searches)', value: 3, disabled: left < 3 ? '(not enough searches left)' : false },
    ],
    default: 1,
  });

  const query = buildQuery(city);
  console.log(`\n${keyValues([['Search', query], ['Uses', `up to ${pages} of your ${leftToday} searches left today`]])}`);
  if (!(await confirm({ message: 'Start?', default: true }))) return;

  const started = Date.now();
  const result = await findLeads(db, createLlmProvider(), { city, pages, force: false }, friendlyHooks());
  const mins = ((Date.now() - started) / 60000).toFixed(1);

  const d = result.discover;
  const q = result.qualify;
  console.log(title('Done'));
  console.log(
    keyValues([
      ['Found on Google', d.skippedByCache ? 'skipped (this city was searched recently)' : `${d.placesSeen} businesses, ${d.added} new`],
      ['Websites checked', String(result.crawl.companies)],
      ['Emails found', String(result.crawl.contactsAdded)],
      ['Ready to email', pc.green(String(q.byDecision.qualified ?? 0))],
      ['Need your decision', q.awaitingReview ? pc.yellow(String(q.awaitingReview)) : '0'],
      ['Not a fit', String(q.byDecision.disqualified ?? 0)],
      ['Time taken', `${mins} min`],
    ]),
  );
  if (q.awaitingReview) console.log(`\n${ok('Next: choose "Review companies that need a decision" from the menu.')}`);
  await pause();
}
