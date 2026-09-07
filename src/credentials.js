// Password import from browsers + autofill.
//
// Sources, in order of reliability:
//   1. Chromium-family direct import (Chrome, Edge, Brave, Opera, Vivaldi): reads the browser's
//      "Login Data" SQLite and decrypts with the DPAPI-wrapped AES key from "Local State".
//      Chrome 127+ can wrap that key with app-bound encryption (v20); those entries are NOT
//      decryptable from another process by design — we detect and report that honestly.
//   2. CSV import: every browser (including Firefox) can export passwords to CSV. Always works.
//
// Stored credentials are encrypted at rest with safeStorage (DPAPI on Windows), like API tokens.
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

function credsFile() { return path.join(app.getPath('userData'), 'credentials.json'); }

// ---------- encrypted store ----------
function loadAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(credsFile(), 'utf8'));
    if (!raw.ct) return [];
    if (!safeStorage.isEncryptionAvailable()) return [];
    return JSON.parse(safeStorage.decryptString(Buffer.from(raw.ct, 'base64')));
  } catch { return []; }
}

function saveAll(list) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage unavailable');
  const ct = safeStorage.encryptString(JSON.stringify(list)).toString('base64');
  fs.mkdirSync(path.dirname(credsFile()), { recursive: true });
  fs.writeFileSync(credsFile(), JSON.stringify({ ct, count: list.length, savedAt: new Date().toISOString() }, null, 2));
}

function hostOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return String(url || '').toLowerCase(); }
}

function mergeCredentials(incoming) {
  const list = loadAll();
  const seen = new Set(list.map(c => `${c.host}|${c.username}`));
  let added = 0;
  for (const c of incoming) {
    if (!c.username || !c.password) continue;
    const key = `${c.host}|${c.username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(c);
    added++;
  }
  saveAll(list);
  return { added, total: list.length };
}

// ---------- Windows DPAPI (no native module: use .NET via PowerShell) ----------
function dpapiUnprotect(buf) {
  return new Promise((resolve, reject) => {
    const b64 = buf.toString('base64');
    const ps = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;` +
      `$b=[Convert]::FromBase64String('${b64}');` +
      `$o=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
      `[Convert]::ToBase64String($o)`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 }, (err, stdout) => {
      if (err) return reject(new Error('DPAPI unprotect failed'));
      resolve(Buffer.from(String(stdout).trim(), 'base64'));
    });
  });
}

// ---------- Chromium family ----------
const CHROMIUM_BROWSERS = [
  { name: 'Chrome', dir: ['Google', 'Chrome', 'User Data'] },
  { name: 'Edge', dir: ['Microsoft', 'Edge', 'User Data'] },
  { name: 'Brave', dir: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  { name: 'Vivaldi', dir: ['Vivaldi', 'User Data'] },
  { name: 'Opera', dir: ['Opera Software', 'Opera Stable'], flat: true },
  { name: 'Opera GX', dir: ['Opera Software', 'Opera GX Stable'], flat: true },
];

function localAppData() { return process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'); }
function roamingAppData() { return process.env.APPDATA || path.join(app.getPath('home'), 'AppData', 'Roaming'); }

// Detect installed Chromium browsers and their profiles that actually have a password DB.
function listChromiumProfiles() {
  const out = [];
  for (const b of CHROMIUM_BROWSERS) {
    for (const base of [path.join(localAppData(), ...b.dir), path.join(roamingAppData(), ...b.dir)]) {
      if (!fs.existsSync(base)) continue;
      const profiles = b.flat ? [''] : ['Default', ...(() => {
        try { return fs.readdirSync(base).filter(d => /^Profile \d+$/.test(d)); } catch { return []; }
      })()];
      for (const p of profiles) {
        const profileDir = p ? path.join(base, p) : base;
        const loginData = path.join(profileDir, 'Login Data');
        if (!fs.existsSync(loginData)) continue;
        const localState = path.join(b.flat ? profileDir : base, 'Local State');
        out.push({ browser: b.name, profile: p || 'Default', profileDir, loginData, localState });
      }
      break; // first existing base wins for this browser
    }
  }
  return out;
}

async function chromiumKey(localStatePath) {
  const state = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const b64 = state && state.os_crypt && state.os_crypt.encrypted_key;
  if (!b64) throw new Error('no encrypted_key in Local State');
  const blob = Buffer.from(b64, 'base64');
  if (blob.slice(0, 5).toString() !== 'DPAPI') throw new Error('unexpected key format');
  return dpapiUnprotect(blob.slice(5));
}

// v10/v11: AES-256-GCM with the DPAPI-unwrapped key. v20: app-bound (Chrome 127+) — not decryptable here.
function decryptChromiumValue(buf, key) {
  if (!buf || !buf.length) return null;
  const prefix = buf.slice(0, 3).toString();
  if (prefix === 'v20') return { locked: true };
  if (prefix === 'v10' || prefix === 'v11') {
    const iv = buf.slice(3, 15);
    const payload = buf.slice(15, buf.length - 16);
    const tag = buf.slice(buf.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return { value: Buffer.concat([d.update(payload), d.final()]).toString('utf8') };
  }
  return { legacy: true }; // pre-v10 DPAPI-per-value; rare on current browsers
}

async function importFromChromium(profile) {
  const tmp = path.join(app.getPath('temp'), `mam-logins-${Date.now()}.db`);
  fs.copyFileSync(profile.loginData, tmp); // copy: the browser holds a lock on the live DB
  let key = null; let keyError = null;
  try { key = await chromiumKey(profile.localState); } catch (err) { keyError = err.message; }
  const creds = []; let locked = 0; let failed = 0;
  try {
    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare('SELECT origin_url, username_value, password_value FROM logins').all();
    db.close();
    for (const r of rows) {
      if (!r.username_value) continue;
      if (!key) { failed++; continue; }
      try {
        const res = decryptChromiumValue(Buffer.from(r.password_value), key);
        if (res && res.locked) { locked++; continue; }
        if (!res || typeof res.value !== 'string') { failed++; continue; }
        creds.push({
          host: hostOf(r.origin_url), url: r.origin_url,
          username: r.username_value, password: res.value,
          source: `${profile.browser} (${profile.profile})`, importedAt: new Date().toISOString(),
        });
      } catch { failed++; }
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
  const result = mergeCredentials(creds);
  return {
    ...result, found: creds.length, locked, failed, keyError,
    note: locked
      ? `${locked} entries use app-bound encryption (Chrome 127+) and cannot be read by another app — export those to CSV from the browser and import the file instead.`
      : (keyError ? `Could not unwrap the browser key: ${keyError}` : null),
  };
}

// ---------- CSV (works for every browser, including Firefox) ----------
function parseCsv(text) {
  const rows = [];
  let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v !== ''));
}

function importFromCsv(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!rows.length) throw new Error('CSV is empty');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const iUrl = header.findIndex(h => ['url', 'website', 'origin', 'login_uri', 'web site'].includes(h));
  const iUser = header.findIndex(h => ['username', 'login', 'user', 'login_username', 'user name', 'email'].includes(h));
  const iPass = header.findIndex(h => ['password', 'login_password', 'pass'].includes(h));
  if (iUser === -1 || iPass === -1) throw new Error('CSV needs at least username and password columns');
  const creds = rows.slice(1).map(r => ({
    host: hostOf(iUrl > -1 ? r[iUrl] : ''), url: iUrl > -1 ? r[iUrl] : '',
    username: (r[iUser] || '').trim(), password: r[iPass] || '',
    source: `CSV: ${path.basename(filePath)}`, importedAt: new Date().toISOString(),
  })).filter(c => c.username && c.password);
  const result = mergeCredentials(creds);
  return { ...result, found: creds.length, locked: 0, failed: 0, note: null };
}

// ---------- autofill ----------
function matchesFor(url) {
  const host = hostOf(url);
  if (!host) return [];
  return loadAll()
    .filter(c => c.host && (c.host === host || host.endsWith(`.${c.host}`) || c.host.endsWith(`.${host}`)))
    .map(c => ({ host: c.host, username: c.username, source: c.source }));
}

function credentialFor(host, username) {
  return loadAll().find(c => c.host === host && c.username === username) || null;
}

// Fill the focused page's login form. Runs in the page (isolated world is fine — it touches the DOM only).
const FILL_JS = (user, pass) => `(() => {
  const u = ${JSON.stringify(user)}, p = ${JSON.stringify(pass)};
  const set = (el, v) => {
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const vis = el => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
  const pw = [...document.querySelectorAll('input[type=password]')].find(vis);
  const userSel = 'input[type=email],input[type=text],input[name*=user i],input[id*=user i],input[name*=email i],input[id*=email i],input[autocomplete=username]';
  let uEl = null;
  if (pw && pw.form) uEl = [...pw.form.querySelectorAll(userSel)].filter(vis).pop() || null;
  if (!uEl) uEl = [...document.querySelectorAll(userSel)].filter(vis)[0] || null;
  const okU = uEl ? set(uEl, u) : false;
  const okP = pw ? set(pw, p) : false;
  if (okP) pw.focus(); else if (okU) uEl.focus();
  return { user: okU, password: okP };
})()`;

async function fillInto(webContents, host, username) {
  const cred = credentialFor(host, username);
  if (!cred) throw new Error('credential not found');
  const res = await webContents.executeJavaScript(FILL_JS(cred.username, cred.password), true);
  if (!res || (!res.user && !res.password)) throw new Error('No login fields found on this page');
  return res;
}

// ---------- per-account remembered logins ----------
// A credential captured inside an account's own view is bound to that account, so each of your
// accounts on the same service keeps its own login and refills correctly.
function rememberForAccount(svc, id, { url, username, password }) {
  if (!password) return { saved: false };
  const list = loadAll();
  const accountKey = `${svc}::${id}`;
  const host = hostOf(url);
  const idx = list.findIndex(c => c.accountKey === accountKey && (c.username || '') === (username || ''));
  const entry = {
    accountKey, host, url, username: username || '', password,
    source: 'saved in app', importedAt: new Date().toISOString(),
  };
  if (idx > -1) {
    if (list[idx].password === password) return { saved: false }; // unchanged
    list[idx] = entry;
  } else list.push(entry);
  saveAll(list);
  return { saved: true };
}

// Prefer the login captured for THIS account; fall back to an imported one matching the site host.
function forAccount(svc, id, hostHint) {
  const list = loadAll();
  const accountKey = `${svc}::${id}`;
  const own = list.find(c => c.accountKey === accountKey);
  if (own) return own;
  const host = hostOf(hostHint || '');
  if (!host) return null;
  return list.find(c => c.host && (c.host === host || host.endsWith(`.${c.host}`) || c.host.endsWith(`.${host}`))) || null;
}

function stats() {
  const list = loadAll();
  const bySource = {};
  for (const c of list) bySource[c.source] = (bySource[c.source] || 0) + 1;
  return { total: list.length, bySource, available: safeStorage.isEncryptionAvailable() };
}

function clearAll() { try { fs.rmSync(credsFile(), { force: true }); } catch {} return true; }

module.exports = {
  listChromiumProfiles, importFromChromium, importFromCsv,
  matchesFor, fillInto, stats, clearAll, loadAll,
  rememberForAccount, forAccount,
};
