// Password import from browsers + autofill.
//
// Sources, in order of reliability:
//   1. Chromium-family direct import (Chrome, Edge, Brave, Opera, Vivaldi): reads the browser's
//      "Login Data" SQLite and decrypts with the DPAPI-wrapped AES key from "Local State".
//      Chrome 127+ can wrap that key with app-bound encryption (v20); those entries are NOT
//      decryptable from another process by design — we detect and report that honestly.
//   2. Firefox direct import (0.12.0): reads a profile's key4.db + logins.json and decrypts them in
//      pure Node (PBES2 = PBKDF2-HMAC-SHA256 + AES-256-CBC; see firefox-import.js). A profile with
//      a master password, or the pre-63 key format, is refused with a specific message.
//   3. CSV import: every browser (including Firefox) can export passwords to CSV. Always works.
//
// Stored credentials: a v2 AES-256-GCM store whose key sidecar makes it survive restarts (0.13.0).
// The old safeStorage/DPAPI format is read once and migrated; see the store section below.
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const firefoxImport = require('./firefox-import');

function credsFile() { return path.join(app.getPath('userData'), 'credentials.json'); }
function credKeyFile() { return path.join(app.getPath('userData'), 'credkey'); }
function legacyBackupFile() { return path.join(app.getPath('userData'), 'credentials.v1-unreadable.json'); }

// ---------- encrypted store (v2, 0.13.0) ----------
// The store used to be encrypted with safeStorage (DPAPI). On this machine DPAPI's key is per-PROCESS:
// a blob written by one launch cannot be decrypted by the next one, so every restart read the store
// as empty and every logins UI showed nothing (proved 2026-11-03 with a bare two-process probe and
// with unmodified 0.9.0 code against a separately-seeded profile). v2 uses node:crypto AES-256-GCM
// with a 32-byte random key in `credkey` beside the store, inside the app's own profile folder — the
// same place the sessions and cookies live, so the same protection boundary (your Windows user
// account), but no per-process key, so it survives every restart. No new dependency.
//
// Layout: credentials.json = { v: 2, alg, iv, tag, ct, count, savedAt } (all binary as base64).
// A v1 file ({ ct: <safeStorage ciphertext> }) is migrated on the first load that can read it.
const STORE_V2 = 2;
const LEGACY_NOTICE = 'Saved logins from an older version could not be read on this machine '
  + '(Windows per-process encryption quirk) — re-import once and they will survive every future restart.';

let lastLoadError = null;                 // { code, message } — surfaced honestly, never swallowed
let legacyState = { key: '', unreadable: false }; // the v1 file we already failed to decrypt

// The v1 file is re-probed whenever its mtime/size change, so a cached "unreadable" answer can never
// pin an empty list after the file is legitimately replaced (the 0.9.0 cache lesson).
function legacySignature() {
  try {
    const st = fs.statSync(credsFile());
    return { key: `${st.mtimeMs}:${st.size}` };
  } catch { return { key: '' }; }
}

// Is the file on disk still a v1 (safeStorage) store? Read straight from disk, never from the caller's
// belief: it decides whether the one-time "unreadable old store" notice applies, so a stale answer
// would either hide an honest warning or invent one.
function v1OnDisk() {
  try { return !JSON.parse(fs.readFileSync(credsFile(), 'utf8')).v; } catch { return false; }
}

function storeError(code, message) {
  lastLoadError = { code, message };
  console.warn(`[logins] store unreadable (${code}): ${message}`);
  return [];
}

function readCredKey({ create = false } = {}) {
  const file = credKeyFile();
  try {
    const key = Buffer.from(String(fs.readFileSync(file, 'utf8')).trim(), 'base64');
    if (key.length === 32) return key;
  } catch {}
  if (!create) return null;
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 }); // 0600 where the OS honours it
  return key;
}

function encryptStore(list) {
  const key = readCredKey({ create: true });
  const iv = crypto.randomBytes(12); // a fresh IV on every write — never reused with the same key
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(list), 'utf8'), c.final()]);
  return {
    v: STORE_V2, alg: 'aes-256-gcm', keyFile: 'credkey',
    iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'),
    count: list.length, savedAt: new Date().toISOString(),
  };
}

// The auth tag is the integrity check: setAuthTag() feeds it in and final() verifies it, so a
// corrupted ciphertext OR tag is refused instead of being handed back as mangled plaintext.
function decryptStore(raw) {
  const key = readCredKey();
  if (!key) throw Object.assign(new Error('the store key (credkey) is missing'), { code: 'NO_KEY' });
  const iv = Buffer.from(String(raw.iv || ''), 'base64');
  const tag = Buffer.from(String(raw.tag || ''), 'base64');
  const ct = Buffer.from(String(raw.ct || ''), 'base64');
  if (iv.length !== 12 || tag.length !== 16 || !ct.length) {
    throw Object.assign(new Error('the store file is malformed'), { code: 'MALFORMED' });
  }
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    throw Object.assign(new Error('the store failed its integrity check (wrong key or damaged file)'), { code: 'AUTH' });
  }
  let parsed;
  try { parsed = JSON.parse(plain); } catch { throw Object.assign(new Error('the store holds invalid JSON'), { code: 'MALFORMED' }); }
  if (!Array.isArray(parsed)) throw Object.assign(new Error('the store is not a list of logins'), { code: 'MALFORMED' });
  return parsed;
}

function writeStoreFile(blob) {
  const file = credsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(blob, null, 2));
  fs.renameSync(tmp, file); // atomic replace: a crash mid-write never leaves a half-written store
}

// Add stable encrypted ids/default lists to entries created by older versions. They stay inside the
// encrypted payload; no password metadata is written to a plaintext sidecar.
function normalizeList(decoded) {
  let migrated = false;
  const list = decoded.map(c => {
    if (!c.id) { migrated = true; c.id = crypto.randomUUID(); }
    if (!Array.isArray(c.defaultForAccounts)) { migrated = true; c.defaultForAccounts = []; }
    return c;
  });
  return { list, migrated };
}

function loadAll() {
  lastLoadError = null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(credsFile(), 'utf8')); } catch { return []; } // no store yet
  if (!raw || typeof raw !== 'object') return [];

  if (raw.v === STORE_V2) {
    let decoded;
    try { decoded = decryptStore(raw); } catch (err) { return storeError(err.code || 'DECRYPT', err.message); }
    legacyState = { key: '', unreadable: false }; // a v2 store replaced any v1 file on disk
    const { list, migrated } = normalizeList(decoded);
    if (migrated) { try { saveAll(list); } catch (err) { lastLoadError = { code: 'WRITE', message: err.message }; } }
    return list;
  }

  if (!raw.ct) return [];
  // v1 (safeStorage/DPAPI). One-time migration: this process can still read it in-process, so
  // re-encrypt to v2 now and replace the file. If it CANNOT be read (the cross-process quirk), the
  // old file is left exactly as it is and the app says so honestly instead of pretending it is empty.
  const sig = legacySignature();
  if (legacyState.unreadable && legacyState.key === sig.key) return [];
  if (!safeStorage.isEncryptionAvailable()) return storeError('OS_UNAVAILABLE', 'OS secure storage is not available yet');
  let decoded;
  try {
    decoded = JSON.parse(safeStorage.decryptString(Buffer.from(raw.ct, 'base64')));
  } catch (err) {
    legacyState = { key: sig.key, unreadable: true };
    console.warn('[logins] the old DPAPI store cannot be decrypted in this process — leaving it untouched');
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  const { list } = normalizeList(decoded);
  try {
    saveAll(list); // v1 -> v2; ids and default flags survive because they were normalised first
    console.log(`[logins] migrated ${list.length} saved login(s) to the restart-safe AES-256-GCM store`);
  } catch (err) {
    lastLoadError = { code: 'WRITE', message: err.message }; // keep serving the readable v1 list
  }
  return list;
}

function saveAll(list) {
  for (const c of list) {
    if (!c.id) c.id = crypto.randomUUID();
    if (!Array.isArray(c.defaultForAccounts)) c.defaultForAccounts = [];
  }
  // A v1 store that could not be read is preserved under its own name before v2 takes over the path:
  // a re-import is the recovery, but losing the old bytes silently would not be honest.
  if (legacyState.unreadable && legacyState.key === legacySignature().key) {
    try { fs.copyFileSync(credsFile(), legacyBackupFile()); } catch {}
  }
  writeStoreFile(encryptStore(list));
  legacyState = { key: '', unreadable: false };
  lastLoadError = null;
}

// What the app needs to say about the store: whether an old-format store is sitting there unreadable
// (the one-time "re-import once" notice), and whether the current store failed its integrity check.
function storeState() {
  loadAll(); // never answer from a stale probe
  // Both conditions are needed: the file must STILL be the old format, and this process must have
  // failed to read it. A v1 file that decrypted fine has already been migrated away by loadAll.
  const legacyUnreadable = v1OnDisk() && legacyState.unreadable;
  return {
    format: STORE_V2,
    legacyUnreadable,
    notice: legacyUnreadable ? LEGACY_NOTICE : null,
    error: lastLoadError ? { code: lastLoadError.code, message: lastLoadError.message } : null,
  };
}

function hostOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return String(url || '').toLowerCase(); }
}

function mergeCredentials(incoming) {
  const list = loadAll();
  // Imported rows dedupe against other imported rows only. Never let an import overwrite an
  // account-captured login that happens to share the same host and username.
  const idx = new Map();
  list.forEach((c, i) => { if (!c.accountKey) idx.set(`${c.host}|${c.username}`, i); });
  let added = 0; let updated = 0;
  for (const incomingCred of incoming) {
    if (!incomingCred.username || !incomingCred.password) continue;
    const key = `${incomingCred.host}|${incomingCred.username}`;
    const at = idx.get(key);
    if (at != null) {
      // Same host+user re-imported with a different password: browser is the newer source of truth.
      if (list[at].password !== incomingCred.password) {
        list[at] = { ...incomingCred, id: list[at].id, defaultForAccounts: list[at].defaultForAccounts || [] };
        updated++;
      }
      continue;
    }
    idx.set(key, list.length);
    list.push(incomingCred);
    added++;
  }
  saveAll(list);
  return { added, updated, total: list.length };
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

// ---------- Firefox (key4.db + logins.json, decrypted in pure Node) ----------
// Modern Firefox (63+) does not use the ASN.1/3DES scheme D12 assumed: it is PBES2 —
// PBKDF2-HMAC-SHA256 + AES-256-CBC — and the only unusual parts are the 14-byte stored IV
// (rebuilt as `04 0e || iv`) and the SHA1(globalSalt || password) PBKDF2 input. The reader lives in
// firefox-import.js; this is the product seam around it.
function listFirefoxProfiles() {
  try { return firefoxImport.listFirefoxProfiles(); } catch { return []; }
}

function importFromFirefox(profile) {
  let read;
  try {
    read = firefoxImport.readFirefoxLogins(profile.profileDir);
  } catch (err) {
    // A refusal is the point, not a crash: the profile is master-password protected, corrupt or an
    // old-format profile. Report the specific reason and import NOTHING.
    return {
      added: 0, updated: 0, total: loadAll().length,
      found: 0, locked: 0, failed: 0, keyError: null,
      scanned: 0, skippedBlank: 0, skippedNonWeb: 0,
      refused: err.code || 'FIREFOX_ERROR',
      note: err.message,
    };
  }
  const label = profile.profile || path.basename(profile.profileDir || '');
  const importedAt = new Date().toISOString();
  const creds = read.logins.map(l => ({
    host: l.host, url: l.url, username: l.username, password: l.password,
    source: `Firefox: ${label}`, importedAt,
  }));
  const result = mergeCredentials(creds);
  const parts = [];
  if (read.skippedNonWeb) parts.push(`${read.skippedNonWeb} saved login${read.skippedNonWeb === 1 ? '' : 's'} for non-web pages (chrome:// or similar) skipped`);
  if (read.skippedBlank) parts.push(`${read.skippedBlank} without a username skipped`);
  if (read.failed) parts.push(`${read.failed} could not be decrypted`);
  return {
    ...result,
    found: read.logins.length,
    locked: 0,
    failed: read.failed,
    keyError: null,
    scanned: read.scanned,
    skippedBlank: read.skippedBlank,
    skippedNonWeb: read.skippedNonWeb,
    refused: null,
    note: parts.length ? parts.join('; ') + '.' : null,
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
// At most ONE captured login per account: matching on accountKey alone (not username) means a
// re-login replaces the previous capture instead of piling up entries that forAccount would then
// pick the first of, forever — the "always force-pastes one specific password" problem.
function rememberForAccount(svc, id, { url, username, password }) {
  if (!password) return { saved: false };
  const list = loadAll();
  const accountKey = `${svc}::${id}`;
  const host = hostOf(url);
  const entry = {
    id: crypto.randomUUID(), accountKey, host, url, username: username || '', password,
    source: 'saved in app', importedAt: new Date().toISOString(), defaultForAccounts: [],
  };
  // Keep separate usernames for the same account so the user can choose among them; re-capturing
  // the SAME username updates that credential instead of preserving a stale password.
  const idx = list.findIndex(c => c.accountKey === accountKey && (c.username || '') === entry.username);
  if (idx > -1) {
    if (list[idx].password === password) return { saved: false };
    entry.id = list[idx].id;
    entry.defaultForAccounts = list[idx].defaultForAccounts || [];
    list[idx] = entry;
  } else list.push(entry);
  saveAll(list);
  return { saved: true };
}

// Drop every credential captured for one account (used when the account is deleted, so a recreated
// account with the same id never inherits the old one's password).
function removeForAccount(svc, id) {
  const key = `${svc}::${id}`;
  const list = loadAll();
  const kept = list.filter(c => c.accountKey !== key);
  let changed = kept.length !== list.length;
  for (const c of kept) {
    const defaults = c.defaultForAccounts || [];
    const next = defaults.filter(k => k !== key);
    if (next.length !== defaults.length) { c.defaultForAccounts = next; changed = true; }
  }
  if (changed) saveAll(kept);
  return list.length - kept.length;
}

function hostRelated(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

// Main-process-only candidate lookup. Never send these objects to the chrome renderer because they
// contain passwords. Use candidateSummariesForAccount for a chooser projection.
function candidatesForAccount(svc, id, hostHint) {
  const accountKey = `${svc}::${id}`;
  const host = hostOf(hostHint || '');
  if (!host) return [];
  return loadAll()
    .filter(c => c.host && hostRelated(c.host, host) && (!c.accountKey || c.accountKey === accountKey))
    .sort((a, b) => Number(b.accountKey === accountKey) - Number(a.accountKey === accountKey));
}

function candidateSummariesForAccount(svc, id, hostHint) {
  return candidatesForAccount(svc, id, hostHint).map(c => ({
    id: c.id, accountKey: c.accountKey || null, host: c.host || '',
    username: c.username || '', source: c.source || 'unknown',
    isDefault: (c.defaultForAccounts || []).includes(`${svc}::${id}`),
  }));
}

// Resolve only a candidate that belongs to the account+live host. A user's explicit per-account
// default wins, then that account's own captured login. An imported login is auto-selected only when
// it is the sole matching imported candidate; ambiguity means no auto-fill and a manual chooser.
function credentialForAccount(svc, id, hostHint, credentialId = null) {
  const accountKey = `${svc}::${id}`;
  const candidates = candidatesForAccount(svc, id, hostHint);
  if (credentialId) return candidates.find(c => c.id === credentialId) || null;
  const preferred = candidates.find(c => (c.defaultForAccounts || []).includes(accountKey));
  if (preferred) return preferred;
  const own = candidates.filter(c => c.accountKey === accountKey);
  if (own.length === 1) return own[0];
  if (own.length > 1) return null; // several captured for this account: ask, never first-wins
  const imported = candidates.filter(c => !c.accountKey);
  return imported.length === 1 ? imported[0] : null;
}

// Backwards-compatible name used by existing autofill call sites.
function forAccount(svc, id, hostHint) { return credentialForAccount(svc, id, hostHint); }

function setDefaultForAccount(credentialId, svc, id, hostHint) {
  const accountKey = `${svc}::${id}`;
  const host = hostOf(hostHint || '');
  if (credentialId) {
    if (host) {
      // normal path: the credential must be a candidate for this account at this site
      if (!candidatesForAccount(svc, id, hostHint).some(c => c.id === credentialId)) {
        throw new Error('That login does not match this account and site');
      }
    } else {
      // hostless import (CSV with no url column): it can never be a fill candidate, so validate by
      // id instead of the host filter — the manager still lets the user mark or clear its default.
      if (!loadAll().some(c => c.id === credentialId)) throw new Error('That login no longer exists');
    }
  }
  const list = loadAll();
  let changed = false;
  for (const c of list) {
    const defaults = Array.isArray(c.defaultForAccounts) ? c.defaultForAccounts : [];
    const next = c.id === credentialId
      ? [...new Set([...defaults.filter(k => k !== accountKey), accountKey])]
      : defaults.filter(k => k !== accountKey);
    if (next.length !== defaults.length || next.some((v, i) => v !== defaults[i])) {
      c.defaultForAccounts = next;
      changed = true;
    }
  }
  if (changed) saveAll(list);
  return credentialId || null;
}

function deleteCredential(credentialId) {
  const list = loadAll();
  const next = list.filter(c => c.id !== credentialId);
  if (next.length === list.length) return false;
  saveAll(next);
  return true;
}

// Safe projection for the chrome renderer. Passwords and raw URLs are never exposed.
function listCredentials() {
  return loadAll().map(c => ({
    id: c.id,
    host: c.host || '',
    username: c.username || '',
    source: c.source || 'unknown',
    importedAt: c.importedAt || null,
    accountKey: c.accountKey || null,
    defaultForAccounts: Array.isArray(c.defaultForAccounts) ? c.defaultForAccounts.slice() : [],
  }));
}

function stats() {
  const list = loadAll();
  const bySource = {};
  for (const c of list) bySource[c.source] = (bySource[c.source] || 0) + 1;
  return { total: list.length, bySource, available: true, format: STORE_V2 };
}

function clearAll() {
  try { fs.rmSync(credsFile(), { force: true }); } catch {}
  try { fs.rmSync(legacyBackupFile(), { force: true }); } catch {}
  legacyState = { key: '', unreadable: false };
  lastLoadError = null;
  return true;
}

module.exports = {
  listChromiumProfiles, importFromChromium, importFromCsv,
  listFirefoxProfiles, importFromFirefox,
  matchesFor, fillInto, stats, clearAll, loadAll, listCredentials, storeState,
  rememberForAccount, forAccount, candidatesForAccount, candidateSummariesForAccount, credentialForAccount, credentialFor,
  setDefaultForAccount, deleteCredential, hostOf, hostRelated, removeForAccount,
};
