import pc from 'picocolors';
import type { ProgressHooks } from '../lib/progress.ts';
import { describeCrawlReason, labelList, QUALIFICATION_LABEL, SERVICE_LABEL, STATUS_LABEL } from './labels.ts';
import { bad, info, ok, truncate, warn, width } from './ui.ts';

/** Progress output for people: one readable line per company, technical detail hidden unless verbose. */
export function friendlyHooks(verbose = false): ProgressHooks {
  const counter = (done: number, total: number) => pc.dim(`[${String(done).padStart(String(total).length)}/${total}]`);
  const nameOf = (name: string | null, domain: string) => truncate(name ?? domain, Math.max(20, Math.floor(width() * 0.4)));
  return {
    step: (m) => console.log(`\n${info(pc.bold(m))}`),
    detail: (m) => {
      if (verbose) console.log(pc.dim(`    ${m}`));
    },
    warn: (m) => console.log(warn(m)),
    crawled: (e) => {
      const head = `${counter(e.done, e.total)} ${nameOf(e.name, e.domain)}`;
      const why = describeCrawlReason(e.reason);
      switch (e.status) {
        case 'crawled':
          console.log(ok(`${head} ${pc.dim('—')} ${e.added ? `${e.added} email(s) found` : 'checked'}${why ? pc.dim(` (${why})`) : ''}`));
          break;
        case 'no_contacts':
          console.log(warn(`${head} ${pc.dim('—')} ${STATUS_LABEL.no_contacts.toLowerCase()}`));
          break;
        case 'opted_out':
          console.log(warn(`${head} ${pc.dim('—')} ${STATUS_LABEL.opted_out.toLowerCase()}`));
          break;
        default:
          console.log(bad(`${head} ${pc.dim('—')} ${why ?? STATUS_LABEL[e.status].toLowerCase()}`));
      }
    },
    qualified: (e) => {
      const head = `${counter(e.done, e.total)} ${nameOf(e.name, e.domain)}`;
      if (e.decision === 'qualified') {
        const services = e.reason.replace(/^fits: /, '').split(', ');
        console.log(ok(`${head} ${pc.dim('—')} ${QUALIFICATION_LABEL.qualified} ${pc.dim(`(${labelList(services, SERVICE_LABEL)})`)}`));
      } else if (e.decision === 'needs_review') {
        console.log(warn(`${head} ${pc.dim('—')} ${QUALIFICATION_LABEL.needs_review} ${pc.dim(`(${e.reason})`)}`));
      } else if (e.decision === 'disqualified') {
        console.log(`${pc.dim('✖')} ${head} ${pc.dim(`— ${QUALIFICATION_LABEL.disqualified} (${e.reason})`)}`);
      } else {
        console.log(bad(`${head} ${pc.dim('—')} AI review failed ${pc.dim(`(${truncate(e.reason, 80)})`)}`));
      }
    },
    sent: (e) => {
      const head = `${counter(e.done, e.total)} ${truncate(e.name, 40)}`;
      if (e.ok) console.log(ok(`${head} ${pc.dim(`— test sent to you (written for ${e.intended})`)}`));
      else console.log(bad(`${head} ${pc.dim('—')} not sent ${pc.dim(`(${truncate(e.error ?? '', 100)})`)}`));
    },
    drafted: (e) => {
      const head = `${counter(e.done, e.total)} ${nameOf(e.name, e.domain)}`;
      if (e.problem) console.log(warn(`${head} ${pc.dim('—')} no draft ${pc.dim(`(${e.problem})`)}`));
      else console.log(ok(`${head} ${pc.dim('—')} ${e.subject}${e.aiOpener ? '' : pc.dim(' (standard opening line)')}`));
    },
  };
}
