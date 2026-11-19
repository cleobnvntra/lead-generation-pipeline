import { ValidationError } from '../../lib/errors.ts';

export interface PlainEmail {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
  /** Extra headers, e.g. List-Unsubscribe. Values are validated against header injection. */
  headers?: Record<string, string>;
}

const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/i;

/** Builds an RFC 5322 plain-text UTF-8 message. Rejects anything that could inject headers. */
export function buildPlainTextMessage(m: PlainEmail): string {
  for (const [label, v] of [['from', m.fromEmail], ['to', m.to]] as const) {
    if (!EMAIL.test(v)) throw new ValidationError(`Invalid ${label} address: ${v}`);
  }
  const headerValues = [m.fromName, m.subject, ...Object.entries(m.headers ?? {}).flat()];
  if (headerValues.some((v) => /[\r\n]/.test(v))) throw new ValidationError('Email headers must not contain line breaks');
  for (const name of Object.keys(m.headers ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,60}$/.test(name)) throw new ValidationError(`Invalid header name: ${name}`);
  }

  const lines = [
    `From: ${encodeWord(m.fromName)} <${m.fromEmail}>`,
    `To: <${m.to}>`,
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    '',
    wrapBase64(Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64')),
  ];
  return lines.join('\r\n');
}

/**
 * Header text: plain if it is simple printable ASCII, otherwise an RFC 2047 encoded-word
 * (covers non-ASCII like "→" and characters with special meaning in address headers).
 */
export function encodeWord(text: string): string {
  const plain = /^[A-Za-z0-9 .,!?'&\-]*$/.test(text);
  if (plain) return text;
  // Encoded-words may be at most 75 chars: split into <=45-byte UTF-8 chunks (never mid-character), folded.
  const chunks: string[] = [];
  let current = '';
  for (const ch of text) {
    if (Buffer.byteLength(current + ch, 'utf8') > 45) {
      chunks.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? '';
}
