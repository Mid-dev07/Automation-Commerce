import { securityHeaders, randomHex } from "./core.mjs";
import { hasOwner } from "./owner-api.mjs";

const CLIENT_SCRIPT = `
const byId = (id) => document.getElementById(id);
let statusBox = byId("authStatus");
let selectedAliasId = "";
let aliasCache = [];
let loginNeedsTotp = false;
let currentNewMachineToken = "";
let dashboardTimer = null;

function setStatus(message, bad) {
  statusBox.textContent = message || "";
  statusBox.className = bad ? "status error" : "status";
}
async function api(path, options) {
  const config = Object.assign({ credentials: "same-origin" }, options || {});
  config.headers = Object.assign({ "Accept": "application/json" }, config.headers || {});
  if (config.body && typeof config.body !== "string") {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(path, config);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || "Permintaan gagal.");
  return data;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function copyText(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (!copied) throw new Error("Clipboard tidak tersedia.");
    }
    setStatus("Berhasil disalin.");
  } catch {
    setStatus("Tidak bisa menyalin otomatis. Pilih teks lalu salin manual.", true);
  }
}
function formatDate(value) {
  return new Date(Number(value)).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}
function emailFor(alias) {
  return alias.slug.length === 24
    ? "receiver+" + alias.slug + "@seiton.my.id"
    : alias.slug + "@seiton.my.id";
}
function showAuth(configured) {
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  statusBox = byId("authStatus");
  byId("auth").hidden = false;
  byId("dashboard").hidden = true;
  byId("setupForm").hidden = configured;
  byId("loginForm").hidden = !configured;
  loginNeedsTotp = false;
  byId("loginPasswordGroup").hidden = false;
  byId("loginPassword").required = true;
  byId("loginTotpGroup").hidden = true;
  byId("loginTotpCode").required = false;
  byId("loginButton").textContent = "Masuk";
  setStatus(configured ? "Masuk untuk membuka panel privat." : "Setup awal: gunakan bootstrap token yang diberikan owner.");
}
function showDashboard() {
  statusBox = byId("dashboardStatus");
  byId("auth").hidden = true;
  byId("dashboard").hidden = false;
  setStatus("Panel siap. Daftar mailbox akan diperbarui otomatis.");
  loadAliases().catch((error) => setStatus(error.message, true));
  loadSecuritySettings().catch((error) => setStatus(error.message, true));
  if (dashboardTimer) clearInterval(dashboardTimer);
  dashboardTimer = setInterval(() => {
    if (document.visibilityState !== "hidden") {
      loadAliases().catch((error) => setStatus(error.message, true));
    }
  }, 10000);
}
function renderAliases() {
  const target = byId("aliases");
  const query = (byId("mailboxSearch")?.value || "").trim().toLowerCase();
  target.replaceChildren();
  const visible = aliasCache.filter((alias) =>
    !query || emailFor(alias).toLowerCase().includes(query) ||
    String(alias.label || "").toLowerCase().includes(query)
  );
  if (!aliasCache.length) {
    target.append(element("p", "empty", "Belum ada mailbox. Buat alamat pertama untuk mulai menerima email."));
    return;
  }
  if (!visible.length) {
    target.append(element("p", "empty", "Tidak ada mailbox yang cocok dengan pencarian."));
    return;
  }
  for (const alias of visible) {
    const card = element("article", "alias-card" + (selectedAliasId === alias.id ? " selected" : ""));
    const heading = element("div", "alias-heading");
    const title = element("strong", "", alias.label || "Mailbox tanpa label");
    const state = element("span", "state active", "Aktif");
    heading.append(title, state);
    const address = element("code", "address", emailFor(alias));
    const detail = element("p", "muted", "Berakhir " + formatDate(alias.expires_at) + " · " + alias.received_count + " email");
    const actions = element("div", "alias-actions");
    const copy = element("button", "button secondary small", "Salin alamat");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(emailFor(alias)));
    const open = element("button", "button small", selectedAliasId === alias.id ? "Inbox terbuka" : "Buka inbox");
    open.type = "button";
    open.setAttribute("aria-pressed", String(selectedAliasId === alias.id));
    open.addEventListener("click", () => selectAlias(alias.id));
    actions.append(copy, open);
    const revoke = element("button", "button danger small", "Hapus mailbox");
    revoke.type = "button";
    revoke.addEventListener("click", () => revokeAlias(alias.id));
    actions.append(revoke);
    card.append(heading, address, detail, actions);
    target.append(card);
  }
}
async function loadAliases() {
  const data = await api("/api/mailboxes");
  aliasCache = (data.mailboxes || data.aliases || []).filter((item) =>
    item.status === "ACTIVE" && Number(item.expires_at) > Date.now()
  );
  renderAliases();
  byId("aliasCount").textContent = String(aliasCache.length);
  if (byId("lastDashboardRefresh")) {
    byId("lastDashboardRefresh").textContent = "Diperbarui " + new Date().toLocaleTimeString("id-ID");
  }

  if (selectedAliasId && !aliasCache.some((item) => item.id === selectedAliasId)) {
    selectedAliasId = "";
    byId("selectedAddress").textContent = "Pilih mailbox yang masih aktif.";
    byId("messages").replaceChildren(element("p", "empty", "Mailbox yang dipilih sudah kedaluwarsa atau tidak aktif."));
    byId("messageCount").textContent = "0";
  }

  if (!selectedAliasId && aliasCache.length) {
    await selectAlias(aliasCache[0].id);
  } else if (selectedAliasId) {
    await loadMessages(selectedAliasId);
  }
}
async function selectAlias(id) {
  selectedAliasId = id;
  renderAliases();
  const selected = aliasCache.find((item) => item.id === id);
  byId("selectedAddress").textContent = selected ? emailFor(selected) : "Pilih mailbox";
  await loadMessages(id);
}
async function loadMessages(id) {
  const target = byId("messages");
  target.replaceChildren();
  if (!id) return;
  const data = await api("/api/messages?mailboxId=" + encodeURIComponent(id));
  const messages = data.messages || [];
  byId("messageCount").textContent = String(messages.length);
  if (!messages.length) {
    target.append(element("p", "empty", "Belum ada email masuk untuk alamat ini."));
    return;
  }
  for (const item of messages) {
    const card = element("article", "message-card");
    const top = element("div", "message-top");
    const title = element("strong", "", item.subject || "(Tanpa subjek)");
    const date = element("span", "muted", formatDate(item.received_at));
    top.append(title, date);
    const sender = element("p", "muted", "Dari: " + (item.sender || "tidak diketahui"));
    card.append(top, sender);
    if (item.verification_code) {
      const codeRow = element("div", "code-row");
      const code = element("code", "otp-code", item.verification_code);
      const copy = element("button", "button small", "Salin kode");
      copy.type = "button";
      copy.addEventListener("click", () => copyText(item.verification_code));
      codeRow.append(code, copy);
      card.append(codeRow);
    } else {
      card.append(element("p", "muted", "Kode tidak terdeteksi otomatis."));
    }
    const disclosure = element("details", "message-body");
    const summary = element("summary", "", "Lihat isi email");
    const preview = element("pre", "body-preview", (item.body_text || "").slice(0, 5000) || "Isi pesan tidak tersedia.");
    disclosure.append(summary, preview);
    card.append(disclosure);
    const remove = element("button", "button danger small", "Hapus pesan");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      try {
        await api("/api/messages/" + encodeURIComponent(item.id), { method: "DELETE" });
        await loadMessages(id);
        setStatus("Pesan dihapus.");
      } catch (error) { setStatus(error.message, true); }
    });
    card.append(remove);
    target.append(card);
  }
}
async function revokeAlias(id) {
  if (!window.confirm("Cabut mailbox ini dan hapus pesan yang tersimpan?")) return;
  try {
    await api("/api/mailboxes/" + encodeURIComponent(id), { method: "DELETE" });
    if (selectedAliasId === id) {
      selectedAliasId = "";
      byId("selectedAddress").textContent = "Pilih mailbox";
      byId("messages").replaceChildren();
    }
    await loadAliases();
    setStatus("Mailbox dicabut dan pesan dihapus.");
  } catch (error) { setStatus(error.message, true); }
}
byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (loginNeedsTotp) {
      await api("/api/login/2fa", { method: "POST", body: { code: byId("loginTotpCode").value } });
      byId("loginTotpCode").value = "";
      loginNeedsTotp = false;
      showDashboard();
      return;
    }
    const result = await api("/api/login", { method: "POST", body: { password: byId("loginPassword").value } });
    byId("loginPassword").value = "";
    if (result.requiresTwoFactor) {
      loginNeedsTotp = true;
      byId("loginPasswordGroup").hidden = true;
      byId("loginPassword").required = false;
      byId("loginTotpGroup").hidden = false;
      byId("loginTotpCode").required = true;
      byId("loginButton").textContent = "Verifikasi 2FA";
      byId("loginTotpCode").focus();
      setStatus("Password benar. Masukkan kode autentikator atau recovery code.");
      return;
    }
    showDashboard();
  } catch (error) { setStatus(error.message, true); }
});
byId("setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/setup", {
      method: "POST",
      body: {
        bootstrapToken: byId("bootstrapToken").value,
        password: byId("setupPassword").value
      }
    });
    byId("setupForm").reset();
    showDashboard();
  } catch (error) { setStatus(error.message, true); }
});

async function loadSecuritySettings() {
  const status = await api("/api/2fa/status");
  byId("twoFactorStatus").textContent = status.enabled
    ? "2FA aktif. Sisa recovery codes: " + status.recovery_codes_remaining
    : "2FA belum aktif. Aktifkan untuk mewajibkan kode autentikator saat login Owner.";
  byId("enableTwoFactor").hidden = status.enabled;
  byId("disableTwoFactorForm").hidden = !status.enabled;
  await loadMachineTokens();
}
async function loadMachineTokens() {
  const data = await api("/api/machine-tokens");
  const target = byId("machineTokenList");
  target.replaceChildren();
  if (!data.tokens.length) {
    target.append(element("p", "empty", "Belum ada token agent. Token lama MAIL_VM_API_TOKEN tetap berlaku selama masih dikonfigurasi."));
    return;
  }
  for (const token of data.tokens) {
    const card = element("article", "alias-card");
    const title = element("strong", "", token.label);
    const prefix = element("code", "address", token.token_prefix + "…");
    const meta = element("p", "muted",
      token.status + " • dibuat " + formatDate(token.created_at) +
      (token.last_used_at ? " • terakhir dipakai " + formatDate(token.last_used_at) : " • belum pernah dipakai"));
    card.append(title, prefix, meta);
    if (token.status === "ACTIVE") {
      const revoke = element("button", "button danger small", "Cabut token");
      revoke.type = "button";
      revoke.addEventListener("click", async () => {
        if (!window.confirm("Cabut token " + token.label + "? Agent ini akan langsung kehilangan akses; agent lain tidak terpengaruh.")) return;
        try {
          await api("/api/machine-tokens/" + encodeURIComponent(token.id), { method: "DELETE" });
          await loadMachineTokens();
          setStatus("Token agent berhasil dicabut.");
        } catch (error) { setStatus(error.message, true); }
      });
      card.append(revoke);
    }
    target.append(card);
  }
}
byId("enableTwoFactor").addEventListener("click", async () => {
  try {
    const data = await api("/api/2fa/enroll", { method: "POST", body: {} });
    byId("twoFactorSecret").textContent = data.secret;
    byId("twoFactorUri").textContent = data.otpauth_uri;
    byId("twoFactorEnrollment").hidden = false;
    byId("twoFactorCode").focus();
    setStatus("Pendaftaran 2FA berlaku 10 menit. Masukkan kode autentikator untuk mengaktifkan.");
  } catch (error) { setStatus(error.message, true); }
});
byId("copyTwoFactorSecret").addEventListener("click", () => copyText(byId("twoFactorSecret").textContent));
byId("copyTwoFactorUri").addEventListener("click", () => copyText(byId("twoFactorUri").textContent));
byId("confirmTwoFactorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/2fa/confirm", {
      method: "POST",
      body: { code: byId("twoFactorCode").value }
    });
    byId("twoFactorCode").value = "";
    byId("twoFactorEnrollment").hidden = true;
    byId("recoveryCodes").textContent = result.recovery_codes.join("\\n");
    byId("recoveryCodesPanel").hidden = false;
    if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
    byId("twoFactorStatus").textContent = "2FA aktif. Login berikutnya akan meminta kode autentikator.";
    byId("enableTwoFactor").hidden = true;
    byId("disableTwoFactorForm").hidden = false;
    setStatus("2FA aktif. Sesi Owner sudah dicabut. Simpan recovery codes sekarang, lalu masuk kembali.");
    byId("logout").textContent = "Masuk ulang";
  } catch (error) { setStatus(error.message, true); }
});
byId("copyRecoveryCodes").addEventListener("click", () => copyText(byId("recoveryCodes").textContent));
byId("disableTwoFactorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Nonaktifkan 2FA untuk panel Owner?")) return;
  try {
    await api("/api/2fa/disable", {
      method: "POST",
      body: {
        password: byId("disableTwoFactorPassword").value,
        code: byId("disableTwoFactorCode").value
      }
    });
    byId("disableTwoFactorForm").reset();
    showAuth(true);
    setStatus("2FA dinonaktifkan. Masuk kembali untuk membuat sesi baru.");
  } catch (error) { setStatus(error.message, true); }
});
byId("createMachineTokenForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/machine-tokens", {
      method: "POST",
      body: { label: byId("machineTokenLabel").value }
    });
    currentNewMachineToken = result.secret;
    byId("newMachineTokenSecret").textContent = currentNewMachineToken;
    byId("newMachineTokenPanel").hidden = false;
    byId("machineTokenLabel").value = "";
    await loadMachineTokens();
    setStatus("Token dibuat. Salin dan simpan ke secret vault agent sekarang; secret tidak akan ditampilkan lagi.");
  } catch (error) { setStatus(error.message, true); }
});
byId("copyNewMachineToken").addEventListener("click", () => {
  if (currentNewMachineToken) copyText(currentNewMachineToken);
});

byId("mailboxSearch").addEventListener("input", renderAliases);
byId("createAlias").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/mailboxes", {
      method: "POST",
      body: {
        label: byId("aliasLabel").value,
        ttlSeconds: Number(byId("aliasTtl").value)
      }
    });
    byId("aliasLabel").value = "";
    await loadAliases();
    await copyText(data.mailbox.email);
    await selectAlias(data.mailbox.id);
    setStatus("Mailbox SeitonMail dibuat dan disalin: " + data.mailbox.email);
  } catch (error) { setStatus(error.message, true); }
});
byId("refresh").addEventListener("click", () => loadAliases().then(() => setStatus("Inbox diperbarui.")).catch((error) => setStatus(error.message, true)));
byId("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    selectedAliasId = "";
    const state = await api("/api/session");
    showAuth(state.configured);
  } catch (error) { setStatus(error.message, true); }
});
(async function init() {
  try {
    const state = await api("/api/session");
    if (state.authenticated) showDashboard();
    else showAuth(state.configured);
  } catch (error) {
    showAuth(true);
    setStatus(error.message, true);
  }
})();
`;

function renderPanel(nonce, configured) {
  const mode = configured ? "true" : "false";
  const styles = `
:root{color-scheme:light;--page:#F7F5EF;--surface:#FFFFFF;--soft:#F2F0E8;--sage:#E7EDE4;--line:#DFE1DC;--line-strong:#C8CBC3;--ink:#1F2937;--ink-soft:#354253;--muted:#525C68;--brand:#FF6B35;--accent:#B94A22;--accent-dark:#9A3B19;--accent-text:#A94420;--ok-bg:#E7F6EC;--ok-fg:#14532D;--ok-line:#B7E4C7;--danger:#991B1B;--danger-bg:#FEF1F2;--danger-line:#F5C2C7;--r-sm:8px;--r-md:12px;--r-lg:16px;--shadow:0 8px 24px rgba(31,41,55,.06)}
*,*::before,*::after{box-sizing:border-box}
html{min-width:320px;-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--page);color:var(--ink);font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-rendering:optimizeLegibility}
main{width:min(100% - 32px,1180px);margin:0 auto;padding:24px 0 56px}
[hidden]{display:none!important}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}button:disabled{opacity:.58;cursor:wait}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid var(--line)}
.mark{width:38px;height:38px;display:grid;place-items:center;border-radius:10px;background:var(--brand);color:var(--ink);font-size:18px;font-weight:900;letter-spacing:-.04em;flex:none}
.brand strong{display:block;font-size:16px;letter-spacing:-.02em;color:var(--ink)}
.brand small{display:block;color:var(--muted);font-size:12px}
.eyebrow{display:inline-block;margin-bottom:6px;color:var(--accent-text);font-size:12px;font-weight:800;letter-spacing:.08em}
h1{font-size:clamp(24px,3.2vw,30px);line-height:1.18;letter-spacing:-.03em;margin:0;font-weight:800;color:var(--ink)}
h2{font-size:16px;margin:0;font-weight:750;letter-spacing:-.015em;color:var(--ink)}
.muted{color:var(--muted);font-size:13px;margin:4px 0 0}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:20px;box-shadow:0 1px 2px rgba(31,41,55,.05)}
.auth{max-width:440px;margin:40px auto 0;border-top:4px solid var(--brand);border-radius:var(--r-lg);padding:28px;box-shadow:var(--shadow)}
.auth-heading{margin-bottom:20px}.auth-heading p{color:var(--muted);font-size:14px;margin:6px 0 0;line-height:1.55}
.auth label,.panel label{display:block;margin:13px 0 6px;font-size:13px;font-weight:700;color:var(--ink-soft)}
input,select{width:100%;min-width:0;min-height:42px;border:1px solid var(--line-strong);border-radius:var(--r-sm);padding:9px 12px;background:var(--surface);color:var(--ink);font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:#7C8591}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(185,74,34,.16)}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;border:1px solid var(--accent);border-radius:var(--r-sm);padding:8px 14px;background:var(--accent);color:#FFFFFF;font-size:13px;font-weight:700;transition:background .15s,border-color .15s}
.button:hover{background:var(--accent-dark);border-color:var(--accent-dark)}
.button.secondary{background:var(--surface);color:var(--ink);border-color:var(--line-strong)}
.button.secondary:hover{background:var(--soft);border-color:#9DA4AE}
.button.danger{background:var(--danger-bg);color:var(--danger);border-color:var(--danger-line)}
.button.danger:hover{background:#FDE2E4;border-color:#E79EA6}
.button.small{min-height:36px;padding:6px 11px;font-size:12px}
.auth .button{width:100%;margin-top:18px;min-height:44px}
.muted-note{margin:16px 0 0;color:var(--muted);font-size:12px;line-height:1.6}
.status{min-height:20px;margin:10px 0;color:var(--muted);font-size:13px;font-weight:600}
.status.error{color:var(--danger)}
.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.topbar p{margin:5px 0 0;color:var(--muted);font-size:14px}
.top-actions{display:flex;gap:8px;flex-wrap:wrap}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:16px 0}
.stat{padding:14px 16px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface);box-shadow:0 1px 2px rgba(31,41,55,.04)}
.stat strong{display:inline-block;margin-right:8px;font-size:22px;font-weight:800;letter-spacing:-.03em;color:var(--ink);font-variant-numeric:tabular-nums}
.stat span{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:minmax(330px,.95fr) minmax(0,1.35fr);gap:14px;align-items:start}
.panel-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
.panel-heading p{margin:4px 0 0;color:var(--muted);font-size:13px}
.create-row{display:grid;grid-template-columns:minmax(0,1fr) 144px auto;gap:8px;align-items:end}
.create-row label{margin-top:0}.create-row button{min-height:42px;white-space:nowrap}
.helper{color:var(--muted);font-size:12px;margin:10px 0 0;line-height:1.5}
.search-wrap{margin:16px 0 10px}.search-wrap label{margin-top:0}
.alias-list,.message-list{display:grid;gap:10px;margin-top:12px}
.alias-card,.message-card{min-width:0;padding:15px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface);transition:border-color .15s}
.alias-card:hover,.message-card:hover{border-color:var(--line-strong)}
.alias-card.selected{border-color:var(--accent);background:#FFFDFB;box-shadow:inset 3px 0 0 var(--brand)}
.alias-heading,.message-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.alias-heading strong,.message-top strong{font-size:14px;color:var(--ink);overflow-wrap:anywhere}
.state{flex:0 0 auto;border:1px solid var(--ok-line);border-radius:999px;padding:3px 9px;background:var(--ok-bg);color:var(--ok-fg);font-size:12px;font-weight:700}
.address{display:block;margin:8px 0;color:var(--accent-text);font:600 13px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.alias-card .muted{font-size:12px;font-variant-numeric:tabular-nums}
.alias-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.empty{padding:28px 16px;text-align:center;border:1px dashed var(--line-strong);border-radius:var(--r-md);background:var(--soft);color:var(--muted);font-size:13px}
.empty strong{display:block;margin-bottom:4px;color:var(--ink);font-size:14px}
.selected-address{color:var(--accent-text);font:600 13px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;margin:6px 0 0}
.code-row{display:flex;align-items:center;gap:10px;margin:12px 0 6px;flex-wrap:wrap}
.otp-code{display:inline-block;font:800 22px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:.12em;background:var(--ok-bg);border:1px solid var(--ok-line);color:var(--ok-fg);border-radius:var(--r-sm);padding:8px 12px}
.message-card .muted{margin:5px 0;font-size:12px;font-variant-numeric:tabular-nums}
.message-body{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.message-body summary{cursor:pointer;color:var(--accent-text);font-size:13px;font-weight:700;width:max-content}
.body-preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;background:var(--soft);border:1px solid var(--line);border-radius:var(--r-sm);padding:12px;margin:9px 0 0;font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--ink)}
.footnote{color:var(--ink-soft);font-size:12px;line-height:1.6;margin:20px 0 0;padding:14px 16px;border:1px solid #D3DDD0;border-radius:var(--r-md);background:var(--sage)}
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.settings-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:18px}
.settings-card summary{cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:15px;font-weight:750;list-style:none;color:var(--ink)}
.settings-card summary::-webkit-details-marker{display:none}
.settings-card summary::after{content:"+";color:var(--muted);font-size:19px;font-weight:400}
.settings-card[open] summary::after{content:"−"}
.settings-content{padding-top:14px}.settings-content p{font-size:13px;line-height:1.55}
.settings-content code,.settings-content pre{overflow-wrap:anywhere;white-space:pre-wrap}
.settings-content .button{margin-top:10px}.settings-content form{margin-top:12px}
@media(max-width:900px){.grid{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}}
@media(max-width:640px){main{width:calc(100% - 24px);padding:16px 0 40px}.brand{margin-bottom:20px}.topbar{align-items:flex-start;flex-direction:column}.top-actions{width:100%}.top-actions button{flex:1;min-height:44px}.stats{grid-template-columns:1fr}.create-row{grid-template-columns:1fr 1fr}.create-row .submit-cell{grid-column:1/-1}.create-row .submit-cell button{width:100%;min-height:44px}.settings-grid{grid-template-columns:1fr}.panel{padding:16px}.button,.button.small{min-height:44px}}
@media(max-width:390px){.create-row{grid-template-columns:1fr}.create-row .submit-cell{grid-column:auto}.panel-heading{display:block}.panel-heading p{margin-top:5px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#F7F5EF"><title>SeitonMail · Panel Owner</title>
<style nonce="${nonce}">${styles}</style></head><body><main>
<header class="brand"><span class="mark">S</span><span><strong>SeitonMail</strong><small>Panel pengelola</small></span></header>
<section id="auth" class="panel auth">
  <div class="auth-heading"><span class="eyebrow">AKSES PRIVAT</span><h1>Masuk ke panel</h1><p>Kelola alamat email dan pesan masuk dari satu tempat.</p></div>
  <form id="setupForm" hidden>
    <label for="bootstrapToken">Bootstrap token sekali pakai</label><input id="bootstrapToken" type="password" autocomplete="off" required>
    <label for="setupPassword">Buat password Owner</label><input id="setupPassword" type="password" minlength="16" maxlength="128" autocomplete="new-password" required>
    <p class="muted-note">Gunakan password minimal 16 karakter. Token inisialisasi hanya digunakan sekali.</p>
    <button class="button" type="submit">Siapkan panel</button>
  </form>
  <form id="loginForm" hidden>
    <div id="loginPasswordGroup"><label for="loginPassword">Password Owner</label><input id="loginPassword" type="password" autocomplete="current-password" required></div>
    <div id="loginTotpGroup" hidden><label for="loginTotpCode">Kode autentikator atau recovery code</label><input id="loginTotpCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="32" placeholder="Kode 6 digit atau recovery code"></div>
    <button id="loginButton" class="button" type="submit">Masuk</button>
  </form>
  <div id="authStatus" class="status" role="status" aria-live="polite"></div>
  <p class="muted-note">Halaman ini hanya untuk pengelola. Agent terhubung menggunakan token terpisah, bukan akun Owner.</p>
</section>
<section id="dashboard" hidden>
  <div class="topbar"><div><span class="eyebrow">PENGELOLAAN EMAIL</span><h1>Mailbox</h1><p>Buat alamat, salin untuk digunakan, lalu pantau pesan masuk.</p></div>
    <div class="top-actions"><button id="refresh" class="button secondary" type="button">Perbarui inbox</button><button id="logout" class="button danger" type="button">Keluar</button></div>
  </div>
  <div id="dashboardStatus" class="status" role="status" aria-live="polite"></div>
  <div class="stats"><div class="stat"><strong id="aliasCount">0</strong><span>mailbox aktif</span></div><div class="stat"><strong id="messageCount">0</strong><span>pesan di inbox terpilih</span></div><div class="stat"><span id="lastDashboardRefresh">Belum diperbarui</span></div></div>
  <div class="grid">
    <section class="panel">
      <div class="panel-heading"><div><h2>Buat mailbox</h2><p>Alamat akan disalin otomatis setelah dibuat.</p></div></div>
      <form id="createAlias" class="create-row">
        <div><label for="aliasLabel">Nama atau label <span class="muted">(opsional)</span></label><input id="aliasLabel" maxlength="80" placeholder="Contoh: Verifikasi akun"></div>
        <div><label for="aliasTtl">Masa aktif</label><select id="aliasTtl"><option value="600">10 menit</option><option value="3600">1 jam</option><option value="21600">6 jam</option><option value="43200">12 jam</option><option value="86400" selected>1 hari</option><option value="259200">3 hari</option><option value="604800">7 hari</option><option value="1209600">14 hari</option><option value="2592000">30 hari</option></select></div>
        <div class="submit-cell"><label>&nbsp;</label><button class="button" type="submit">Buat alamat</button></div>
      </form>
      <p class="helper">Maksimal 100 email per mailbox. Pesan dihapus saat mailbox kedaluwarsa atau dicabut.</p>
      <div class="search-wrap"><label for="mailboxSearch">Cari alamat atau label</label><input id="mailboxSearch" type="search" placeholder="Ketik untuk mencari…" autocomplete="off"></div>
      <div id="aliases" class="alias-list"><p class="empty">Memuat mailbox…</p></div>
    </section>
    <section class="panel">
      <div class="panel-heading"><div><h2>Pesan masuk</h2><p id="selectedAddress" class="selected-address">Pilih mailbox untuk melihat pesan.</p></div></div>
      <div id="messages" class="message-list"><p class="empty">Pilih mailbox di sebelah kiri.</p></div>
    </section>
  </div>
  <div class="settings-grid">
    <details class="settings-card">
      <summary>Keamanan Owner dan 2FA</summary>
      <div class="settings-content">
        <p id="twoFactorStatus" class="muted">Memeriksa status 2FA…</p>
        <button id="enableTwoFactor" class="button secondary" type="button">Aktifkan 2FA</button>
        <div id="twoFactorEnrollment" hidden>
          <p class="muted">Tambahkan kunci ini di aplikasi autentikator, lalu konfirmasi dengan kode terbaru.</p>
          <label>Kunci rahasia TOTP</label><code id="twoFactorSecret" class="address"></code><button id="copyTwoFactorSecret" class="button secondary small" type="button">Salin kunci</button>
          <label>URI otpauth</label><code id="twoFactorUri" class="address"></code><button id="copyTwoFactorUri" class="button secondary small" type="button">Salin URI</button>
          <form id="confirmTwoFactorForm"><label for="twoFactorCode">Kode 6 digit</label><input id="twoFactorCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required><button class="button" type="submit">Konfirmasi 2FA</button></form>
        </div>
        <div id="recoveryCodesPanel" hidden><p><strong>Simpan recovery codes di tempat aman.</strong> Setiap kode hanya dapat digunakan sekali.</p><pre id="recoveryCodes" class="body-preview"></pre><button id="copyRecoveryCodes" class="button secondary small" type="button">Salin recovery codes</button></div>
        <form id="disableTwoFactorForm" hidden><label for="disableTwoFactorPassword">Password Owner</label><input id="disableTwoFactorPassword" type="password" autocomplete="current-password" required><label for="disableTwoFactorCode">Kode TOTP atau recovery code</label><input id="disableTwoFactorCode" type="text" autocomplete="one-time-code" required><button class="button danger" type="submit">Nonaktifkan 2FA</button></form>
      </div>
    </details>
    <details class="settings-card">
      <summary>Akses agent</summary>
      <div class="settings-content">
        <p class="muted">Buat token terpisah untuk setiap agent. Secret hanya ditampilkan satu kali.</p>
        <form id="createMachineTokenForm"><label for="machineTokenLabel">Nama agent</label><input id="machineTokenLabel" maxlength="60" placeholder="Contoh: Cue CEO" required><button class="button" type="submit">Buat token agent</button></form>
        <div id="newMachineTokenPanel" hidden><p><strong>Token baru · salin sekarang</strong></p><code id="newMachineTokenSecret" class="address"></code><button id="copyNewMachineToken" class="button secondary small" type="button">Salin token</button><p class="muted">Simpan di secret vault agent. Token tidak dapat ditampilkan kembali.</p></div>
        <div id="machineTokenList" class="alias-list"></div>
      </div>
    </details>
  </div>
  <p class="footnote">SeitonMail menerima email masuk saja. Lampiran tidak disimpan. Gunakan alamat sementara untuk pengujian dan verifikasi yang sah, bukan untuk pemulihan akun penting atau informasi finansial.</p>
</section>
</main><script nonce="${nonce}">window.MAIL_SETUP_MODE=${mode};</script><script nonce="${nonce}">${CLIENT_SCRIPT}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    }
  });
}
async function handlePanel(request, env) {
  const nonce = randomHex(32);
  const html = renderPanel(nonce, await hasOwner(env));
  return new Response(html, {
    status: 200,
    headers: securityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    })
  });
}

export {
  renderPanel,
  handlePanel
};
