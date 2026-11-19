import { select, Separator } from '@inquirer/prompts';
import { getEnv } from '../config/env.ts';
import { getCompanyDetails, listLeads } from '../controllers/companyController.ts';
import type { Db } from '../db/connection.ts';
import { openExternal } from '../lib/openExternal.ts';
import { renderCompanyCard } from '../views/companyCard.ts';
import { dim, info, newPage, ok, title } from '../views/ui.ts';
import { addEmailFlow, decisionFlow } from './companies.ts';
import { explainError, pause } from './prompts.ts';

/** Walks through every company waiting for a human decision, one page per company. */
export async function reviewFlow(db: Db): Promise<void> {
  const queue = listLeads(db, { qualification: 'needs_review' }, 500).map((r) => r.company.id);
  if (queue.length === 0) {
    console.log(`\n${ok('Nothing waiting for your decision.')}`);
    await pause();
    return;
  }

  let decided = 0;
  let flash: string | null = null; // carried onto the next page (e.g. result of the previous decision)
  for (const [i, id] of queue.entries()) {
    for (;;) {
      const d = getCompanyDetails(db, id);
      // Decided already (adding an email may clear the AI verdict; the user can still decide here).
      if (d.company.qualification === 'qualified' || d.company.qualification === 'disqualified') break;
      newPage(flash);
      flash = null;
      console.log(title(`Review: company ${i + 1} of ${queue.length}`));
      console.log(dim('  Look at the details, open the website if needed, then decide.'));
      console.log(renderCompanyCard(d, getEnv().DATA_DIR));

      const hasEmail = d.contacts.length > 0;
      const action = await select({
        message: 'Your decision:',
        choices: [
          { name: 'Yes — ready to email', value: 'yes', disabled: hasEmail ? false : '(add an email first)' },
          { name: 'No — not a fit', value: 'no' },
          { name: 'Open their website first', value: 'open' },
          { name: 'Add an email I found on their website', value: 'email' },
          { name: 'Skip for now', value: 'skip' },
          new Separator(),
          { name: '← Stop reviewing', value: 'stop' },
        ],
      });
      try {
        if (action === 'stop') {
          newPage(ok(`Reviewed ${decided} compan${decided === 1 ? 'y' : 'ies'}.`));
          await pause();
          return;
        }
        if (action === 'skip') {
          flash = info(`Skipped ${d.company.name ?? d.company.domain}.`);
          break;
        }
        if (action === 'open') {
          openExternal(d.company.website_url);
          flash = ok('Opened their website in your browser. Come back here when you have looked.');
          continue;
        }
        if (action === 'email') {
          flash = (await addEmailFlow(db, d.company)).message;
          continue;
        }
        const message = await decisionFlow(db, d.company, action === 'yes' ? 'qualified' : 'disqualified');
        if (message) {
          decided++;
          flash = message;
        }
        break;
      } catch (err) {
        flash = explainError(err);
      }
    }
  }
  newPage(flash);
  console.log(ok(`All done — reviewed ${decided} compan${decided === 1 ? 'y' : 'ies'}.`));
  await pause();
}
