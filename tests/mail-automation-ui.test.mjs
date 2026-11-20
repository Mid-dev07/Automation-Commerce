import test from "node:test";
import assert from "node:assert/strict";
import { renderPublicPage } from "../mail-automation/public-page.mjs";

test("public SeitonMail page renders a practical Indonesian mailbox flow", async () => {
  const response = renderPublicPage("abc123de");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<html lang="id">/);
  assert.match(html, /SeitonMail — Email praktis/);
  assert.match(html, /Buat alamat\. Terima email\. Salin kode\./);
  assert.match(html, /id="createForm"/);
  assert.match(html, /id="tabGenerate"/);
  assert.match(html, /id="tabCustom"/);
  assert.match(html, /id="copyAddress"/);
  assert.match(html, /id="copyPassword"/);
  assert.match(html, /id="openInbox"/);
});

test("public SeitonMail page gives inbox OTP and privacy actions clear priority", async () => {
  const response = renderPublicPage("abc123de");
  const html = await response.text();

  assert.match(html, /id="copyInboxAddress"/);
  assert.match(html, /id="refreshInbox"/);
  assert.match(html, /id="logoutInbox"/);
  assert.match(html, /KODE VERIFIKASI/);
  assert.match(html, /Salin kode/);
  assert.match(html, /Lihat isi email/);
  assert.match(html, /setInterval\(async\(\)=>/);
});

test("public SeitonMail page retains nonce-based security and avoids remote UI dependencies", async () => {
  const response = renderPublicPage("abc123de");
  const html = await response.text();
  const csp = response.headers.get("Content-Security-Policy");

  assert.match(html, /<style nonce="abc123de">/);
  assert.match(html, /<script nonce="abc123de">/);
  assert.match(csp, /style-src 'nonce-abc123de'/);
  assert.match(csp, /script-src 'nonce-abc123de'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com/);
});
