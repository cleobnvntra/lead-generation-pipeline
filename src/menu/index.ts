import { select, Separator } from '@inquirer/prompts';
import pc from 'picocolors';
import { statusCounts } from '../controllers/companyController.ts';
import type { Db } from '../db/connection.ts';
import { advancedFlow, overviewFlow } from './advanced.ts';
import { addByHandFlow, browseFlow, lookupFlow } from './companies.ts';
import { draftsFlow } from './drafts.ts';
import { DraftModel } from '../models/draftModel.ts';
import { findLeadsFlow } from './findLeads.ts';
import { guarded, isExitPrompt } from './prompts.ts';
import { reviewFlow } from './review.ts';
import { newPage } from '../views/ui.ts';

function header(db: Db): string {
  const { qualification: q, status: s } = statusCounts(db);
  const problems = (s.no_contacts ?? 0) + (s.crawl_failed ?? 0);
  const parts = [
    pc.green(`${q.qualified ?? 0} ready to email`),
    (q.needs_review ?? 0) > 0 ? pc.yellow(`${q.needs_review} need your decision`) : pc.dim('0 need your decision'),
    pc.dim(`${problems} website problem${problems === 1 ? '' : 's'}`),
  ];
  return `\n${pc.bold(pc.cyan('Lead Finder'))}\n${parts.join(pc.dim('  ·  '))}\n`;
}

/** Interactive main menu. Ctrl+C at any prompt exits cleanly. */
export async function runMenu(db: Db): Promise<void> {
  try {
    for (;;) {
      newPage();
      console.log(header(db));
      const waiting = statusCounts(db).qualification.needs_review ?? 0;
      const drafts = new DraftModel(db);
      const needDraft = drafts.listEligible(1000, false).length;
      const toApprove = drafts.counts().draft ?? 0;
      const draftBadge = [needDraft ? `${needDraft} to write` : '', toApprove ? `${toApprove} to approve` : ''].filter(Boolean).join(', ');
      const choice = await select({
        message: 'What would you like to do?',
        pageSize: 12,
        choices: [
          { name: 'Find new leads in a city', value: 'find', description: 'Search Google, check websites for emails, and let the AI sort them' },
          {
            name: `Review companies that need a decision${waiting ? pc.yellow(` (${waiting})`) : ''}`,
            value: 'review',
            description: 'Go through them one by one and decide yes or no',
          },
          {
            name: `Email drafts${draftBadge ? pc.yellow(` (${draftBadge})`) : ''}`,
            value: 'drafts',
            description: 'Write, edit and approve emails for companies that are ready (nothing is sent)',
          },
          { name: 'Browse leads', value: 'browse', description: 'See lists: ready to email, needs decision, not a fit, problems' },
          { name: 'Look up a company', value: 'lookup', description: 'Search by name or website and see everything about it' },
          { name: 'Add a company or email by hand', value: 'add', description: 'For sites you checked yourself in your browser' },
          { name: 'Overview', value: 'overview', description: 'Totals and how many Google searches are left' },
          { name: 'More tools', value: 'advanced', description: 'Re-check websites, re-run the AI, export to a spreadsheet' },
          new Separator(),
          { name: 'Exit', value: 'exit' },
        ],
      });
      if (choice === 'exit') break;
      newPage();
      await guarded(async () => {
        if (choice === 'find') await findLeadsFlow(db);
        if (choice === 'review') await reviewFlow(db);
        if (choice === 'drafts') await draftsFlow(db);
        if (choice === 'browse') await browseFlow(db);
        if (choice === 'lookup') await lookupFlow(db);
        if (choice === 'add') await addByHandFlow(db);
        if (choice === 'overview') await overviewFlow(db);
        if (choice === 'advanced') await advancedFlow(db);
      });
    }
  } catch (err) {
    if (!isExitPrompt(err)) throw err;
  }
  console.log(pc.dim('\nGoodbye.'));
}
