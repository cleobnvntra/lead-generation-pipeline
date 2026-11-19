import { z } from 'zod';
import { ExternalApiError } from '../../lib/errors.ts';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const sendResponseSchema = z.object({ id: z.string().min(1), threadId: z.string().optional() });

/** Sends a raw RFC 5322 message as the signed-in account. Returns Gmail's message id. */
export async function gmailSendRaw(accessToken: string, rawMessage: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(rawMessage, 'utf8').toString('base64url') }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ExternalApiError(`Could not reach Gmail: ${(err as Error).message}`, 0);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      /* keep raw */
    }
    throw new ExternalApiError(`Gmail refused the email (HTTP ${res.status}): ${detail}`, res.status);
  }
  const parsed = sendResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new ExternalApiError('Unexpected response from Gmail.', res.status);
  return parsed.data.id;
}
