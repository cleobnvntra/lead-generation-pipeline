import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeWebsiteUrl, registrableDomain, sameSite } from '../src/lib/domain.ts';
import { ValidationError } from '../src/lib/errors.ts';

test('normalizeWebsiteUrl adds https and strips fragments', () => {
  assert.equal(normalizeWebsiteUrl('acmepm.ca').href, 'https://acmepm.ca/');
  assert.equal(normalizeWebsiteUrl(' http://www.acmepm.ca/x#y ').href, 'http://www.acmepm.ca/x');
});

test('normalizeWebsiteUrl rejects unsafe or invalid input', () => {
  for (const bad of [
    '',
    '   ',
    'ftp://acmepm.ca',
    'javascript:alert(1)',
    'https://user:pw@acmepm.ca',
    'http://127.0.0.1',
    'http://[::1]/',
    'http://localhost:3000',
    'http://printer.local',
    'https://co.uk',
    'not a url',
    'x'.repeat(3000),
  ]) {
    assert.throws(() => normalizeWebsiteUrl(bad), ValidationError, bad);
  }
  assert.throws(() => normalizeWebsiteUrl(42 as unknown), ValidationError);
});

test('registrableDomain and sameSite handle multi-part suffixes', () => {
  assert.equal(registrableDomain('www.toronto.acme.co.uk'), 'acme.co.uk');
  assert.equal(registrableDomain('WWW.AcmePM.CA'), 'acmepm.ca');
  assert.equal(sameSite('www.acmepm.ca', 'acmepm.ca'), true);
  assert.equal(sameSite('acmepm.ca', 'acmepm.com'), false);
});
