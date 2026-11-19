import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyEmail,
  cleanEmail,
  decodeCfEmail,
  emailOnDomain,
  findOptOuts,
  looksJsRendered,
  parseMailto,
  parsePage,
} from '../src/services/crawler/extract.ts';

const PAGE = new URL('https://www.acmepm.ca/');

function cfEncode(email: string, key = 0x42): string {
  return [key, ...[...email].map((c) => c.charCodeAt(0) ^ key)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('cleanEmail accepts real addresses and normalizes case/punctuation', () => {
  assert.equal(cleanEmail('Jane.Doe@AcmePM.ca'), 'jane.doe@acmepm.ca');
  assert.equal(cleanEmail('info@acmepm.ca.'), 'info@acmepm.ca');
  assert.equal(cleanEmail('mailto:office@acme-pm.co.uk'), 'office@acme-pm.co.uk');
});

test('cleanEmail rejects junk, placeholders, assets and excluded mailboxes', () => {
  for (const bad of [
    'logo@2x.png',
    'name@example.com',
    'abc@sentry.io',
    '123@sentry-next.wixpress.com',
    'noreply@acmepm.ca',
    'careers@acmepm.ca',
    'privacy@acmepm.ca',
    'humanresources@acmepm.ca',
    'a..b@acmepm.ca',
    '.a@acmepm.ca',
    'a@b@acmepm.ca',
    'a@-acme.ca',
    'a@acme',
    `${'x'.repeat(65)}@acmepm.ca`,
    '',
  ]) {
    assert.equal(cleanEmail(bad), null, bad);
  }
});

test('classifyEmail distinguishes shared mailboxes from people', () => {
  assert.equal(classifyEmail('info@acmepm.ca'), 'role');
  assert.equal(classifyEmail('leasing+toronto@acmepm.ca'), 'role');
  assert.equal(classifyEmail('torontoinfo@acmepm.ca'), 'role');
  assert.equal(classifyEmail('info.kw@acmepm.ca'), 'role');
  assert.equal(classifyEmail('kw-leasing@acmepm.ca'), 'role');
  assert.equal(classifyEmail('jane.doe@acmepm.ca'), 'personal');
  assert.equal(classifyEmail('jsmith@acmepm.ca'), 'personal');
});

test('emailOnDomain compares registrable domains', () => {
  assert.equal(emailOnDomain('a@mail.acmepm.ca', 'acmepm.ca'), true);
  assert.equal(emailOnDomain('a@gmail.com', 'acmepm.ca'), false);
});

test('parseMailto handles multiple recipients, encoding and query strings', () => {
  assert.deepEqual(parseMailto('mailto:a@x.ca,%20b@y.ca?subject=Hi'), ['a@x.ca', 'b@y.ca']);
  assert.deepEqual(parseMailto('mailto:%E0%A4%A'), ['%E0%A4%A']); // malformed encoding: kept raw, then rejected by cleanEmail
  assert.deepEqual(parseMailto('mailto:'), []);
});

test('decodeCfEmail round-trips and rejects malformed input', () => {
  assert.equal(decodeCfEmail(cfEncode('info@acmepm.ca')), 'info@acmepm.ca');
  assert.equal(decodeCfEmail('zz'), null);
  assert.equal(decodeCfEmail('abc'), null);
  assert.equal(decodeCfEmail(cfEncode('no-at-sign')), null);
});

test('parsePage finds mailto, text and Cloudflare emails with context, ignoring scripts', () => {
  const html = `<html><body>
    <p>Call or email our office: <a href="mailto:Office@AcmePM.ca?subject=hi">Office@AcmePM.ca</a></p>
    <footer><address>Jane Doe, Portfolio Manager — jane.doe@acmepm.ca</address></footer>
    <p><a href="/cdn-cgi/l/email-protection#${cfEncode('leasing@acmepm.ca')}">[email&#160;protected]</a></p>
    <script>var x = "hidden@acmepm.ca";</script>
    <div hidden>secret@acmepm.ca</div>
  </body></html>`;
  const { emails } = parsePage(html, PAGE);
  const byEmail = Object.fromEntries(emails.map((e) => [e.email, e]));
  assert.deepEqual(Object.keys(byEmail).sort(), ['jane.doe@acmepm.ca', 'leasing@acmepm.ca', 'office@acmepm.ca']);
  assert.equal(byEmail['office@acmepm.ca']!.method, 'mailto');
  assert.equal(byEmail['leasing@acmepm.ca']!.method, 'cfemail');
  assert.equal(byEmail['jane.doe@acmepm.ca']!.method, 'text');
  assert.match(byEmail['jane.doe@acmepm.ca']!.context, /Portfolio Manager/);
});

test('parsePage does not glue adjacent block text into a fake address', () => {
  const html = '<body><div>help</div><div>@acmepm.ca</div><p>x</p><p>info@acmepm.ca</p></body>';
  assert.deepEqual(
    parsePage(html, PAGE).emails.map((e) => e.email),
    ['info@acmepm.ca'],
  );
});

test('parsePage does not glue an inline label onto an address', () => {
  const html =
    '<body><p><span class="d-block">Email</span><a href="mailto:info@acmepm.ca">info@acmepm.ca</a></p>' +
    '<p><b>Contact:</b>jane@acmepm.ca</p><p>Mailoffice@acmepm.ca</p><p>office@acmepm.ca</p></body>';
  assert.deepEqual(
    parsePage(html, PAGE).emails.map((e) => e.email).sort(),
    ['info@acmepm.ca', 'jane@acmepm.ca', 'office@acmepm.ca'],
  );
});

test('parsePage ranks same-site contact/team/about links and drops others', () => {
  const html = `<body>
    <a href="/about-us">About</a>
    <a href="https://acmepm.ca/contact">Contact</a>
    <a href="/our-team/">Meet the team</a>
    <a href="/blog/post">Blog</a>
    <a href="https://facebook.com/acme/contact">FB</a>
    <a href="/brochure-contact.pdf">PDF</a>
    <a href="mailto:x@acmepm.ca">mail</a>
    <a href="#contact">jump</a>
  </body>`;
  const links = parsePage(html, PAGE).links.map((u) => u.pathname);
  assert.deepEqual(links, ['/contact', '/our-team/', '/about-us']);
});

test('looksJsRendered flags empty app shells, not normal pages', () => {
  assert.equal(looksJsRendered('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'), true);
  assert.equal(looksJsRendered('<html><body><div id="__next">  </div></body></html>'), true);
  assert.equal(looksJsRendered('<html><body><noscript>Enable JS</noscript></body></html>'), true);
  const normal = `<html><body><h1>Acme PM</h1><p>${'We manage condominiums across Hamilton. '.repeat(10)}</p></body></html>`;
  assert.equal(looksJsRendered(normal), false);
  assert.equal(looksJsRendered(`<body><div id="root"><p>${'Server-rendered content. '.repeat(20)}</p></div></body>`), false);
});

test('findOptOuts detects CASL refusal wording', () => {
  for (const text of [
    'We do not accept unsolicited commercial emails.',
    'Unsolicited emails will be deleted.',
    'NO SOLICITATION please.',
    'This address is not to be used for marketing purposes.',
    'The company does not consent to receive commercial electronic messages.',
  ]) {
    assert.ok(findOptOuts(text).length > 0, text);
  }
  assert.equal(findOptOuts('Contact us for property management solutions in Toronto.').length, 0);
});
