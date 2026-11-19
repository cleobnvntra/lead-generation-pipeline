import { PLACEHOLDER_ADDRESS, type Brand } from '../../config/brand.ts';
import type { Draft } from '../../models/draftModel.ts';
import { MAX_BODY, MAX_SUBJECT } from '../../models/draftModel.ts';
import type { Company } from '../../models/types.ts';
import { findPlaceholders } from './drafter.ts';

export interface ApprovalCheck {
  /** Block approval (and, in stage 7, sending). */
  problems: string[];
  /** Allowed while testing, but must be fixed before real sending. */
  warnings: string[];
}

/**
 * Rules a draft must meet to be approved. Runs again right before sending, because the company,
 * contact or brand details can change after approval.
 */
export function checkDraftForApproval(
  draft: Pick<Draft, 'subject' | 'body' | 'to_email'>,
  company: Pick<Company, 'qualification' | 'status'>,
  contactEmail: string | null,
  brand: Brand,
): ApprovalCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const subject = draft.subject.trim();
  const body = draft.body;
  const lower = body.toLowerCase();

  // Company and recipient
  if (company.status === 'opted_out') problems.push('the company’s website says it does not want unsolicited email');
  if (company.qualification !== 'qualified') problems.push('the company is no longer marked "Ready to email"');
  if (!contactEmail) problems.push('the email address this draft was written for no longer exists');
  else if (contactEmail !== draft.to_email) problems.push('the recipient no longer matches the saved contact');

  // Subject
  if (subject.length < 3 || subject.length > MAX_SUBJECT) problems.push(`subject must be 3-${MAX_SUBJECT} characters`);
  if (/[\r\n]/.test(subject)) problems.push('subject must be a single line');
  if (/^\s*\[?test\b/i.test(subject)) problems.push('subject must not start with "TEST" (test mode adds its own label)');
  if (findPlaceholders(subject).length) problems.push(`subject has an unfilled placeholder: ${findPlaceholders(subject).join(', ')}`);

  // Body length and placeholders
  if (body.trim().length < 20 || body.length > MAX_BODY) problems.push(`email text must be 20-${MAX_BODY} characters`);
  const placeholders = findPlaceholders(body);
  const otherPlaceholders = placeholders.filter((p) => p !== PLACEHOLDER_ADDRESS);
  if (otherPlaceholders.length) problems.push(`email text has unfilled placeholders: ${otherPlaceholders.join(', ')}`);

  // CASL: identify the sender, give contact info and a mailing address, offer an unsubscribe
  if (!lower.includes(brand.businessName.toLowerCase())) problems.push(`email must name the business ("${brand.businessName}")`);
  if (!body.includes(brand.phone) && !lower.includes(brand.website.toLowerCase().replace(/\/$/, ''))) {
    problems.push('email must include the business phone number or website');
  }
  if (!/unsubscribe/i.test(body)) problems.push('email must keep the "unsubscribe" line');
  if (brand.mailingAddress) {
    if (!body.includes(brand.mailingAddress)) problems.push('email must include the mailing address from brand.json');
  } else if (body.includes(PLACEHOLDER_ADDRESS)) {
    warnings.push('mailing address is still a placeholder; fine for testing, required before real sending');
  } else {
    problems.push(`email must include the mailing address (or the ${PLACEHOLDER_ADDRESS} placeholder until it is set)`);
  }

  // Only offered services may be mentioned
  const offersMoving = brand.offeredServices.includes('moving_help') || brand.offeredServices.includes('moving_with_truck');
  if (!offersMoving && /\b(moving (help|services?|company)|movers?|moving truck|relocation services?)\b/i.test(body)) {
    problems.push('email mentions moving services, which are not offered');
  }
  return { problems, warnings };
}
