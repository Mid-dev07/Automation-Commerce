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
:root{color-scheme:light;--page:#f4f6f4;--surface:#fff;--soft:#f7f9f7;--line:#e1e7e1;--ink:#17231c;--muted:#6a776e;--accent:#087f5b;--accent-dark:#06684b;--danger:#b42332;--shadow:0 10px 30px rgba(28,50,35,.05)}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(100% - 36px,1180px);margin:0 auto;padding:28px 0 54px}
[hidden]{display:none!important}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.65;cursor:wait}
:focus-visible{outline:3px solid rgba(8,127,91,.24);outline-offset:2px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:34px}.mark{width:36px;height:36px;display:grid;place-items:center;border-radius:10px;background:var(--accent);color:#fff;font-size:18px;font-weight:800}.brand strong{display:block;font-size:15px;letter-spacing:-.02em}.brand small{display:block;color:var(--muted);font-size:11px}
.eyebrow{display:inline-block;margin-bottom:5px;color:var(--accent);font-size:10px;font-weight:750;letter-spacing:.08em}h1{font-size:27px;line-height:1.18;letter-spacing:-.035em;margin:0;font-weight:730}h2{font-size:15px;margin:0;font-weight:700;letter-spacing:-.015em}.muted{color:var(--muted);font-size:12px;margin:5px 0 0}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:19px;box-shadow:var(--shadow)}
.auth{max-width:410px;margin:48px auto 0}.auth-heading{margin-bottom:18px}.auth-heading p{color:var(--muted);font-size:13px;margin:7px 0 0}.auth label,.panel label{display:block;margin:13px 0 6px;font-size:12px;font-weight:650;color:#344239}
input,select{width:100%;min-width:0;border:1px solid #d6ded7;border-radius:8px;padding:10px 11px;background:#fff;color:var(--ink);outline:none}
input::placeholder{color:#9aa69d}input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(8,127,91,.09)}
.button{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--accent);border-radius:8px;padding:9px 12px;background:var(--accent);color:#fff;font-size:12px;font-weight:680}
.button:hover{background:var(--accent-dark);border-color:var(--accent-dark)}.button.secondary{background:#fff;color:#344239;border-color:#d6ded7}.button.secondary:hover{background:var(--soft)}.button.danger{background:#fff;color:var(--danger);border-color:#edc9ce}.button.danger:hover{background:#fff5f6}.button.small{padding:7px 9px;font-size:11px}
.auth .button{width:100%;margin-top:17px;min-height:42px}.muted-note{margin:17px 0 0;color:var(--muted);font-size:11px;line-height:1.6}
.status{min-height:19px;margin:9px 0;color:var(--muted);font-size:12px}.status.error{color:var(--danger)}
.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:17px}.topbar p{margin:5px 0 0;color:var(--muted);font-size:13px}.top-actions{display:flex;gap:7px;flex-wrap:wrap}
.stats{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0}.stat{min-width:145px;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.stat strong{display:inline-block;margin-right:5px;font-size:19px;font-weight:730;letter-spacing:-.03em}.stat span{color:var(--muted);font-size:11px}
.grid{display:grid;grid-template-columns:minmax(320px,.92fr) minmax(0,1.35fr);gap:14px;align-items:start}
.panel-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}.panel-heading p{margin:4px 0 0;color:var(--muted);font-size:11px}
.create-row{display:grid;grid-template-columns:minmax(0,1fr) 140px auto;gap:8px;align-items:end}.create-row label{margin-top:0}.create-row button{height:39px;white-space:nowrap}
.helper{color:var(--muted);font-size:11px;margin:9px 0 0}
.search-wrap{margin:17px 0 10px}.search-wrap label{margin-top:0}.search-wrap input{padding:9px 11px}
.alias-list,.message-list{display:grid;gap:9px;margin-top:12px}
.alias-card,.message-card{min-width:0;padding:13px;border:1px solid var(--line);border-radius:10px;background:#fff}
.alias-card.selected{border-color:#91c9aa;background:#f7fbf8;box-shadow:inset 3px 0 0 var(--accent)}
.alias-heading,.message-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.alias-heading strong,.message-top strong{font-size:12px;overflow-wrap:anywhere}
.state{flex:0 0 auto;border-radius:20px;padding:3px 8px;background:#e8f4ed;color:#14734e;font-size:10px;font-weight:700}
.address{display:block;margin:8px 0;color:#116c4c;font-size:12px;overflow-wrap:anywhere}
.alias-card .muted{font-size:11px}.alias-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.empty{padding:24px 14px;text-align:center;border:1px dashed #ccd7cd;border-radius:10px;color:var(--muted);font-size:12px}.empty strong{display:block;margin-bottom:4px;color:var(--ink);font-size:13px}
.selected-address{color:#116c4c;font-size:12px;overflow-wrap:anywhere;margin:7px 0 0}
.code-row{display:flex;align-items:center;gap:9px;margin:12px 0 5px;flex-wrap:wrap}.otp-code{display:inline-block;font-size:21px;letter-spacing:3px;font-weight:750;background:#eaf5ee;border:1px solid #c9e4d2;color:#075e44;border-radius:8px;padding:6px 10px}
.message-card .muted{margin:5px 0;font-size:11px}.message-body{margin-top:10px;padding-top:9px;border-top:1px solid #edf0ed}.message-body summary{cursor:pointer;color:var(--muted);font-size:11px;width:max-content}.body-preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:230px;overflow:auto;background:#f6f8f6;border-radius:8px;padding:10px;margin:8px 0 0;font:11px/1.55 ui-monospace,monospace;color:#35443a}
.footnote{color:var(--muted);font-size:11px;line-height:1.65;margin:22px 0 0}
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
.settings-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px}
.settings-card summary{cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:13px;font-weight:700;list-style:none}
.settings-card summary::-webkit-details-marker{display:none}.settings-card summary:after{content:"+";color:var(--muted);font-size:18px;font-weight:400}.settings-card[open] summary:after{content:"−"}
.settings-content{padding-top:12px}.settings-content p{font-size:11px;line-height:1.55}.settings-content code,.settings-content pre{overflow-wrap:anywhere;white-space:pre-wrap}
.settings-content .button{margin-top:8px}.settings-content form{margin-top:11px}
@media(max-width:900px){.grid{grid-template-columns:1fr}.settings-grid{grid-template-columns:1fr 1fr}}
@media(max-width:620px){main{width:calc(100% - 24px);padding:18px 0 38px}.brand{margin-bottom:26px}.topbar{align-items:flex-start;flex-direction:column}.top-actions{width:100%}.top-actions button{flex:1}.stats{margin:12px 0}.stat{flex:1;min-width:120px}.create-row{grid-template-columns:1fr 1fr}.create-row .submit-cell{grid-column:1/-1}.create-row .submit-cell button{width:100%}.settings-grid{grid-template-columns:1fr}.panel{padding:16px}}
@media(max-width:390px){.create-row{grid-template-columns:1fr}.create-row .submit-cell{grid-column:auto}.panel-heading{display:block}.panel-heading p{margin-top:5px}}
`;
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#f4f6f4"><title>SeitonMail · Panel Owner</title>
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
