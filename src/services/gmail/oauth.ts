import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { ConfigError, ExternalApiError, ValidationError } from '../../lib/errors.ts';

/** Send-only Gmail access, plus openid/email so we can verify WHICH account signed in. */
export const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'] as const;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const clientFileSchema = z.object({
  installed: z.object({
    client_id: z.string().regex(/\.apps\.googleusercontent\.com$/, 'not a Google OAuth client id'),
    client_secret: z.string().min(10),
  }),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(10),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(10).optional(),
  scope: z.string(),
  id_token: z.string().optional(),
});

const storedTokenSchema = z.object({
  email: z.string(),
  refresh_token: z.string().min(10),
  access_token: z.string(),
  expires_at: z.number(),
  scope: z.string(),
});
export type StoredToken = z.infer<typeof storedTokenSchema>;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Reads the Desktop-app client file downloaded from Google Cloud (never printed or committed). */
export function loadOAuthClient(path: string): OAuthClient {
  if (!existsSync(path)) {
    throw new ConfigError(`Google sign-in file not found at ${path}. Download the Desktop OAuth client JSON from Google Cloud and save it there.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError(`${path} is not valid JSON.`);
  }
  const parsed = clientFileSchema.safeParse(json);
  if (!parsed.success) throw new ConfigError(`${path} is not a Desktop-app OAuth client file (expected an "installed" section).`);
  return { clientId: parsed.data.installed.client_id, clientSecret: parsed.data.installed.client_secret };
}

export function loadToken(path: string): StoredToken | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = storedTokenSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function saveToken(path: string, token: StoredToken): void {
  writeFileSync(path, JSON.stringify(token, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function deleteToken(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Email claim from an id_token received directly from Google's token endpoint over TLS (OIDC §3.1.3.7 allows skipping signature checks here). */
export function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown; email_verified?: unknown };
    return typeof claims.email === 'string' && claims.email_verified === true ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * One-time browser sign-in (loopback + PKCE). Refuses any account other than `expectedEmail`
 * and any grant without gmail.send. Stores a refresh token at `tokenPath`.
 */
export async function signIn(
  client: OAuthClient,
  expectedEmail: string,
  tokenPath: string,
  openBrowser: (url: string) => void,
): Promise<StoredToken> {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');

  const { server, port, code } = await waitForCode(state);
  try {
    const redirectUri = `http://127.0.0.1:${port}`;
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      login_hint: expectedEmail,
      hd: expectedEmail.split('@')[1]!,
    }).toString();
    openBrowser(url.href);

    const authCode = await code;
    const res = await tokenRequest({
      grant_type: 'authorization_code',
      code: authCode,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    const email = emailFromIdToken(res.id_token);
    if (email !== expectedEmail.toLowerCase()) {
      throw new ValidationError(`Signed in as ${email ?? 'an unknown account'}, but EMAIL_FROM is ${expectedEmail}. Sign in with ${expectedEmail}.`);
    }
    if (!res.scope.split(' ').includes('https://www.googleapis.com/auth/gmail.send')) {
      throw new ValidationError('Google did not grant "send email" permission. Try again and click Allow.');
    }
    if (!res.refresh_token) throw new ExternalApiError('Google did not return a refresh token. Disconnect and sign in again.', 200);
    const token: StoredToken = {
      email,
      refresh_token: res.refresh_token,
      access_token: res.access_token,
      expires_at: Date.now() + res.expires_in * 1000,
      scope: res.scope,
    };
    saveToken(tokenPath, token);
    return token;
  } finally {
    server.close();
  }
}

/** Returns a valid access token, refreshing (and re-saving) it when it is about to expire. */
export async function getAccessToken(client: OAuthClient, tokenPath: string, expectedEmail: string): Promise<string> {
  const token = loadToken(tokenPath);
  if (!token) throw new ConfigError('Gmail is not connected yet. Run "Connect Gmail" first.');
  if (token.email !== expectedEmail.toLowerCase()) {
    throw new ConfigError(`Gmail is connected as ${token.email}, but EMAIL_FROM is ${expectedEmail}. Disconnect and connect again.`);
  }
  if (token.expires_at - Date.now() > 60_000) return token.access_token;
  let res;
  try {
    res = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
  } catch (err) {
    if (err instanceof ExternalApiError && err.status === 400) {
      throw new ConfigError('Gmail access was revoked or expired. Disconnect and connect Gmail again.');
    }
    throw err;
  }
  saveToken(tokenPath, { ...token, access_token: res.access_token, expires_at: Date.now() + res.expires_in * 1000 });
  return res.access_token;
}

async function tokenRequest(params: Record<string, string>): Promise<z.infer<typeof tokenResponseSchema>> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ExternalApiError(`Could not reach Google: ${(err as Error).message}`, 0);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      detail = [j.error, j.error_description].filter(Boolean).join(': ') || detail;
    } catch {
      /* keep raw */
    }
    throw new ExternalApiError(`Google sign-in failed (HTTP ${res.status}): ${detail}`, res.status);
  }
  const parsed = tokenResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new ExternalApiError('Unexpected response from Google sign-in.', res.status);
  return parsed.data;
}

/** Local one-shot server on 127.0.0.1 that receives Google's redirect with the authorization code. */
async function waitForCode(expectedState: string): Promise<{ server: Server; port: number; code: Promise<string> }> {
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const finish = (status: number, message: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Lead Generation Pipeline</title><body style="font-family:sans-serif;padding:2rem"><h2>${message}</h2><p>You can close this tab and go back to the app.</p></body>`);
    };
    const error = url.searchParams.get('error');
    if (error) {
      finish(400, 'Sign-in was cancelled.');
      rejectCode(new ValidationError(`Google sign-in was not completed (${error}).`));
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      finish(400, 'Sign-in failed: unexpected request.');
      rejectCode(new ValidationError('Sign-in failed: the response did not match this request. Try again.'));
      return;
    }
    const c = url.searchParams.get('code');
    if (!c) {
      finish(400, 'Sign-in failed: no code received.');
      rejectCode(new ValidationError('Google did not return a sign-in code.'));
      return;
    }
    finish(200, 'Signed in. Gmail is connected.');
    resolveCode(c);
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res());
  });
  const timer = setTimeout(() => rejectCode(new ValidationError('Sign-in timed out after 5 minutes. Try again.')), SIGN_IN_TIMEOUT_MS);
  code.finally(() => clearTimeout(timer)).catch(() => undefined);
  return { server, port: (server.address() as AddressInfo).port, code };
}
