const { app, BaseWindow, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const SERVICES = require('./services');
const tokens = require('./api-tokens');
const { PROVIDERS } = require('./providers');
const content = require('./content');
const dark = require('./darkmode');
const creds = require('./credentials');
const plugins = require('./plugins');
const updater = require('./updater');

const statusCache = new Map(); // accountKey -> { summary?, error?, fetchedAt } — summaries only, tokens never leave main

const TAB_STRIP_H = 48;
const RAIL_W = 240; // left account rail — account views must never cover it (must match --rail in ui.html)
const BANNER_H = 52; // auto-fill notice strip above a view (must match .acctnotice height in ui.html)
const AUTO_FILL_DELAY_MS = 450; // settle time after the form report before auto-filling (SPA forms render late)
const FILL_TIMEOUT_MS = 6000; // a page that never answers (it navigated mid-fill) must not hang the caller
const SETTLE_MS = Number(process.env.SPIKE_SETTLE_MS || 8000);
const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#00a2c7', '#4f8cff', '#8e4ec6', '#e93d82', '#6e56cf', '#00b0a0'];
const permissionConfigured = new WeakSet(); // one permission policy per partition session

// The package was renamed to my-provider-dash-manager for npm, which would move Electron's userData
// (it derives from the package name) and orphan every existing account, session and saved login.
// Pin it to the original folder so upgrades keep their data.
const LEGACY_USER_DATA = 'multi-acc-manager';
if (process.env.MAM_USER_DATA) app.setPath('userData', process.env.MAM_USER_DATA);
else app.setPath('userData', path.join(app.getPath('appData'), LEGACY_USER_DATA));

// ---------- persistence ----------
function userDataPath(name) { return path.join(app.getPath('userData'), name); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- dark mode: Dark Reader's API build, in each account view's isolated world ----------
// Deliberately NOT a browser extension. Dark Reader's MV3 extension cannot work here: its
// background service worker dies on the chrome.* APIs Electron 43 does not expose, and its
// content script declares world:"MAIN", which mutates page prototypes the account's own
// JavaScript can observe — a breach of invariant 2. See src/darkmode.js for the measurements.

const store = {
  accounts: [], // {svc, id, label, colorIdx, proxy, createdAt, lastState}
  settings: { warmLimit: 5, groupTabs: false, collapsed: [], stripCollapsed: [], adBlock: true, darkMode: true, saveLogins: true, autofill: true },
  openTabs: [], // session memory: [{svc, id, url, lastActivated, active}] — survives restarts
  customServices: [], // Phase 2: user-added services {key,name,dashboardUrl,loginUrl,color,custom:true}
  save() {
    writeJson(userDataPath('accounts.json'), this.accounts);
    writeJson(userDataPath('settings.json'), this.settings);
    writeJson(userDataPath('services.json'), this.customServices);
  },
  saveSession() { writeJson(userDataPath('session.json'), this.openTabs); },
  load() {
    this.accounts = readJson(userDataPath('accounts.json'), []);
    const saved = readJson(userDataPath('settings.json'), {});
    // 0.8.0: the force-dark CSS invert is replaced by bundled Dark Reader. A profile that had it
    // on keeps dark mode on, and the dead key is dropped rather than left in the file.
    if (saved.forceDark) saved.darkMode = true;
    delete saved.forceDark;
    this.settings = Object.assign({ warmLimit: 5, groupTabs: false, collapsed: [], stripCollapsed: [], adBlock: true, darkMode: true, saveLogins: true, autofill: true, autoUpdate: true }, saved);
    this.openTabs = readJson(userDataPath('session.json'), []);
    this.customServices = readJson(userDataPath('services.json'), []);
  },
};
function userData(name) { return userDataPath(name); }

// Built-in curated services + user-added generic ones (Phase 2) + plugin manifests (Phase 3).
let pluginServices = [];
let pluginErrors = [];
// Sign-in infrastructure the managed services depend on but that is not a credential host: the
// ad-blocker must leave these alone (EasyList rules hit e.g. accounts.youtube.com/CheckConnection,
// which Google sign-in loads in an iframe). This list grants NO password trust — see serviceHosts.
const AUTH_INFRA_HOSTS = ['accounts.youtube.com', 'accounts.google.com', 'gstatic.com', 'login.microsoftonline.com', 'login.live.com', 'msftauth.net', 'msauth.net', 'appleid.cdn-apple.com'];
function refreshManagedHosts() {
  const hosts = new Set(AUTH_INFRA_HOSTS);
  for (const s of allServices()) for (const h of serviceHosts(s.key)) hosts.add(h);
  content.setManagedHosts([...hosts]);
}
function reloadPlugins() {
  const r = plugins.load();
  pluginServices = r.services;
  pluginErrors = r.errors;
  if (pluginErrors.length) console.error('[plugins] invalid manifests:', pluginErrors.map(e => `${e.file}: ${e.error}`).join('; '));
  refreshManagedHosts();
  return r;
}
// Precedence on key collisions: built-in > user-added > plugin. Two services must never share a key,
// or their accounts would resolve to the same partition namespace.
function allServices() {
  const out = []; const seen = new Set();
  for (const s of [...SERVICES, ...(store.customServices || []), ...pluginServices]) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s);
  }
  return out;
}

// Status providers: built-ins, plus generic ones synthesised from a plugin's api block.
function providerFor(svcKey) {
  if (PROVIDERS[svcKey]) return PROVIDERS[svcKey];
  const winner = serviceByKey(svcKey); // same precedence as allServices(): built-in > custom > plugin
  return winner && winner.plugin && winner.api ? plugins.makeProvider(winner.api) : null;
}
function serviceByKey(key) { return allServices().find(s => s.key === key); }

function sanitizeId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'acc';
}
function partitionFor(svc, id) { return `persist:${svc}__${sanitizeId(id)}`; }
function partitionDir(svc, id) { return path.join(app.getPath('userData'), 'Partitions', `${svc}__${sanitizeId(id)}`); }

function findAccount(svc, id) { return store.accounts.find(a => a.svc === svc && a.id === id); }
function registerAccount(svc, id, label) {
  let acc = findAccount(svc, id);
  if (!acc) {
    acc = { svc, id, label: label || id, colorIdx: store.accounts.length % COLORS.length, proxy: '', createdAt: new Date().toISOString(), lastState: 'unknown' };
    store.accounts.push(acc);
    store.save();
  }
  return acc;
}
function accountKey(svc, id) { return `${svc}::${id}`; }

// ---- credential origin guard ----
// A tab can navigate anywhere (outbound links, OAuth popups routed into the same partition), so a
// saved password must only ever be captured from, or filled into, the service's own domains.
function serviceHosts(svcKey) {
  const s = serviceByKey(svcKey);
  if (!s) return [];
  const fromUrls = [s.dashboardUrl, s.loginUrl, s.signupUrl].filter(Boolean).map(u => creds.hostOf(u));
  const extra = Array.isArray(s.extraHosts) ? s.extraHosts.map(h => creds.hostOf(`https://${h}/`)) : [];
  return [...new Set([...fromUrls, ...extra].filter(Boolean))];
}
function originAllowed(svcKey, url) {
  const host = creds.hostOf(url || '');
  if (!host) return false;
  return serviceHosts(svcKey).some(h => creds.hostRelated(host, h));
}

// A display name for a service key, for honest user-facing messages ("No saved login for this
// Vercel account yet") without leaking anything.
function svcOfName(key) {
  const s = serviceByKey(key);
  return (s && s.name) || key;
}

// Summaries for an explicit candidate set (the fill fallback resolves across several service hosts,
// so creds.candidateSummariesForAccount's single-host lookup cannot be used for the chooser).
function summariesOf(candidates, svc, id) {
  const key = accountKey(svc, id);
  return candidates.map(c => ({
    id: c.id, accountKey: c.accountKey || null, host: c.host || '',
    username: c.username || '', source: c.source || 'unknown',
    isDefault: (c.defaultForAccounts || []).includes(key),
  }));
}

// ---------- saved-login summaries (0.9.0) ----------
// Every projection below is summary-only: id / username / host / source / ★. Passwords stay in
// src/credentials.js and never reach this renderer (invariant 3).
//
// NOT cached. loadAll() runs the one-time migration that saves the decrypted list back through
// safeStorage; on the very first call of a fresh profile that save can throw (the file was created
// moments earlier), and credentials.js then answers [] for that call. Caching that answer made the
// manager permanently empty until a restart (found on the seeded demo profile: 10 logins on disk,
// 0 in the UI, because the first emitState ran during window construction). Reading per call costs
// one DPAPI decrypt against a small JSON file, which is the honest trade for never showing a stale
// empty list.
function credSummaries() { return creds.listCredentials(); }

// The logins that belong to ONE account: its own captures plus imported logins whose site is one of
// the service's own hosts, with ★ marking the account's explicit default. A capture made by a
// DIFFERENT account of the same service is deliberately excluded — it is that account's login.
function accountLoginSummaries(svc, id, list) {
  const key = accountKey(svc, id);
  const hosts = serviceHosts(svc);
  return (list || credSummaries())
    .filter(c => (c.accountKey
      ? c.accountKey === key
      : !!c.host && hosts.some(h => creds.hostRelated(c.host, h))))
    .map(c => ({
      id: c.id, username: c.username || '', host: c.host || '', source: c.source || 'unknown',
      own: c.accountKey === key, isDefault: (c.defaultForAccounts || []).includes(key),
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.own) - Number(a.own)
      || String(a.username).localeCompare(String(b.username)));
}

// The manager list: every stored login, classified by service, plus the accounts it can serve and
// the ★ marker for each. `accounts` is computed in main so the renderer never guesses, and every
// mutation returns this fresh list — that is what keeps ★ in sync (0.8.0 juggled it client-side).
function managerRows(list) {
  return (list || credSummaries()).map(c => {
    const accountSvc = c.accountKey ? c.accountKey.split('::')[0] : null;
    const serviceKeys = accountSvc ? [accountSvc] : allServices()
      .filter(s => serviceHosts(s.key).some(h => creds.hostRelated(c.host, h)))
      .map(s => s.key);
    const accounts = (c.accountKey
      ? store.accounts.filter(a => accountKey(a.svc, a.id) === c.accountKey)
      : store.accounts.filter(a => serviceKeys.includes(a.svc)))
      .map(a => ({ key: accountKey(a.svc, a.id), svc: a.svc, id: a.id, label: a.label || a.id }));
    return {
      id: c.id, host: c.host || '', username: c.username || '', source: c.source || 'unknown',
      importedAt: c.importedAt || null, accountKey: c.accountKey || null,
      defaultForAccounts: Array.isArray(c.defaultForAccounts) ? c.defaultForAccounts.slice() : [],
      serviceKeys, accounts,
    };
  });
}

// Remember a login as this account's default after a Use/fill. credentials.js validates a default
// against ONE host hint, and the fill call site may be a dashboard while the login belongs to the
// service's sign-in host (the case "Use from the manager" exists for). So pick the host of the
// service whose candidate set actually contains the credential — never an arbitrary host, and never
// one outside serviceHosts() (the D14 gate).
function useAsDefault(svc, id, credentialId) {
  const hosts = serviceHosts(svc);
  const host = hosts.find(h => creds.candidatesForAccount(svc, id, `https://${h}/`).some(c => c.id === credentialId)) || hosts[0] || '';
  creds.setDefaultForAccount(credentialId, svc, id, host);
}

// ---------- per-site picker (0.10.0) ----------
// What the key chip in the address strip counts, and what its popover lists: everything that could
// sign you in on the host the tab is ON right now — this account's own captures for that host, plus
// every SHARED import whose host relates to it (the owner's "all my google passes on any google
// login field"; imports are not owned by an account, so they are the same list for every account).
// A capture made by a DIFFERENT account of the same service is deliberately NOT here: invariant 1
// binds a credential to its account AND origin, and 0.9.0's accountLoginSummaries draws the same
// boundary ("it is that account's login"). Widening this to siblings would let one account's tab
// read another account's saved password on a shared host — the account half of D14.
// Summaries only: id / username / host / source / ★.
function siteLoginRows(svc, id, liveUrl, list) {
  const host = creds.hostOf(liveUrl || '');
  if (!host) return { host: '', rows: [] };
  const key = accountKey(svc, id);
  const rows = (list || credSummaries())
    .filter(c => c.host && creds.hostRelated(c.host, host))
    .filter(c => !c.accountKey || c.accountKey === key)
    .map(c => {
      // An import has no owning account, so its label is null; if a credential ever carries another
      // account's key it would be named here (the projection stays honest either way).
      const owner = c.accountKey && c.accountKey !== key ? store.accounts.find(a => accountKey(a.svc, a.id) === c.accountKey) : null;
      return {
        id: c.id, username: c.username || '', host: c.host || '', source: c.source || 'unknown',
        own: c.accountKey === key, accountLabel: owner ? (owner.label || owner.id) : null,
        isDefault: (c.defaultForAccounts || []).includes(key),
      };
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.own) - Number(a.own)
      || String(a.username).localeCompare(String(b.username)));
  return { host, rows };
}

// Copying a saved password is the one operation that touches the secret outside a fill. It stays in
// the MAIN process: the value goes from credentials.js straight to the OS clipboard, and the caller
// gets a label, never the value (invariant 3 holds and is not weakened by a reveal path).
// `svc`/`id`/`liveUrl` are supplied by the IPC wrapper from the ACTIVE TAB (never from the renderer),
// so a copy can only ever happen on the tab the picker belongs to.
function copyCredentialField(credentialId, field, svc, id, liveUrl) {
  if (field !== 'username' && field !== 'password') return { ok: false, reason: 'bad-field', message: 'Unknown field.' };
  const liveHost = creds.hostOf(liveUrl || '');
  // The same gate every fill passes (D14): the tab must be ON one of this service's own sites...
  if (!originAllowed(svc, liveUrl)) {
    return {
      ok: false, reason: 'foreign-host',
      message: `This tab is on ${liveHost || 'another site'}, not ${serviceHosts(svc)[0] || 'the service'} — refusing to copy a saved password here.`,
    };
  }
  const key = accountKey(svc, id);
  // ...and the credential must be one THIS account may use on this page: its own capture for the
  // live site, or a shared import for it. Another account's capture is refused here even though the
  // picker never lists it — the account half of invariant 1 (a capture belongs to its account).
  const cred = creds.loadAll().find(c => c.id === credentialId);
  if (!cred) return { ok: false, reason: 'unknown-id', message: 'That saved login no longer exists.' };
  if (cred.accountKey && cred.accountKey !== key) return { ok: false, reason: 'other-account', message: 'That saved login belongs to a different account.' };
  if (!cred.host || !creds.hostRelated(cred.host, liveHost)) return { ok: false, reason: 'other-site', message: 'That saved login belongs to a different site.' };
  const value = field === 'password' ? cred.password : cred.username;
  if (!value) return { ok: false, reason: 'empty', message: `That saved login has no ${field} stored.` };
  clipboard.writeText(value);
  return { ok: true, field, label: `${field === 'password' ? 'password' : 'email'} for ${cred.username || cred.host || 'this login'}` };
}

// Explicit clear semantics for creds-default (0.8.0 relied on the "null id never matches" side
// effect). A null id may ONLY clear: it never sets a default anywhere, and it needs the account it
// applies to. Returns the authoritative manager list either way.
function setOrClearDefault(credentialId, svc, id, hostHint) {
  if (credentialId == null) {
    if (!svc || !id) throw new Error('Clearing a default needs the account it applies to');
    creds.setDefaultForAccount(null, svc, id, hostHint);
  } else {
    creds.setDefaultForAccount(credentialId, svc, id, hostHint);
  }
  return managerRows();
}

// The D30 resolution ladder over an explicit candidate set (main-process copy, used only when the
// tab's live host matched nothing and we resolve against the service's hosts). Explicit default
// first, then this account's single own capture, then a single imported match; anything ambiguous
// resolves to null so the UI asks instead of guessing. smoke:creds pins this to the identical
// outcomes of creds.credentialForAccount() on a single host.
function resolveAmong(candidates, accountKeyValue, credentialId) {
  if (credentialId) return candidates.find(c => c.id === credentialId) || null;
  const preferred = candidates.find(c => (c.defaultForAccounts || []).includes(accountKeyValue));
  if (preferred) return preferred;
  const own = candidates.filter(c => c.accountKey === accountKeyValue);
  if (own.length === 1) return own[0];
  if (own.length > 1) return null;
  const imported = candidates.filter(c => !c.accountKey);
  return imported.length === 1 ? imported[0] : null;
}

// Candidates for a fill: the tab's LIVE host first (unchanged, D14). When the live page matches no
// saved login (a dashboard) fall back to this account's logins for the SERVICE's own hosts — still
// host-gated: every host here comes from serviceHosts(), and the call site refuses a live URL that
// is not a service host before this runs.
function fillCandidatesFor(svc, id, pageUrl) {
  const live = creds.candidatesForAccount(svc, id, pageUrl);
  if (live.length) return { candidates: live, source: 'live' };
  const byId = new Map();
  for (const host of serviceHosts(svc)) {
    for (const c of creds.candidatesForAccount(svc, id, `https://${host}/`)) byId.set(c.id, c);
  }
  const candidates = [...byId.values()]
    .sort((a, b) => Number(b.accountKey === accountKey(svc, id)) - Number(a.accountKey === accountKey(svc, id)));
  return { candidates, source: candidates.length ? 'service' : 'none' };
}

// What the automatic path should do when a sign-in form appears. `skip` reasons are honest: the
// master toggle is off, this account opted out, the page is not the service's own site, or there is
// simply nothing saved. `choose` replaces 0.8.0's silent skip when several logins match (D30).
function autoFillPlan(svc, id, url, opts = {}) {
  const settings = opts.settings || store.settings;
  const account = opts.account !== undefined ? opts.account : findAccount(svc, id);
  if (!settings || !settings.autofill) return { kind: 'skip', reason: 'autofill-off' };
  if (account && account.noAutoFill) return { kind: 'skip', reason: 'account-opt-out' };
  if (!originAllowed(svc, url)) return { kind: 'skip', reason: 'foreign-host' };
  const cred = creds.credentialForAccount(svc, id, url);
  if (cred) return { kind: 'fill', credentialId: cred.id, username: cred.username };
  const choices = creds.candidateSummariesForAccount(svc, id, url);
  if (choices.length > 1) return { kind: 'choose', choices };
  return { kind: 'skip', reason: choices.length ? 'unresolved' : 'no-login' };
}

// ---------- per-account content settings (0.11.0) ----------
// Ad-block and dark mode have ONE app-wide toggle each (Home) and were read from store.settings at
// every apply site. An account may now carry a sparse `contentOverride: { adBlock?: 'on'|'off',
// darkMode?: 'on'|'off' }`: ONLY the keys the user changed exist, so an untouched account's stored
// record is byte-identical to before (measured: the sparse shape is the only one that round-trips
// byte-identically; `{}` and null-filled shapes leave bytes behind). 'follow' is encoded as the
// ABSENT key, which is what updateContentOverride() enforces.
const CONTENT_NAMES = ['adBlock', 'darkMode'];
const CONTENT_VALUES = ['on', 'off', 'follow'];

// Modelled on autoFillPlan: pure, dependency-injected via `settings`, exported for smoke. The
// follow branch is derived from settings[name] — never a hardcoded default — so a future change to
// the app-wide default flows through every untouched account with no code change here.
function resolveContent(acc, name, settings) {
  const v = acc && acc.contentOverride ? acc.contentOverride[name] : undefined;
  if (v === 'on') return true;
  if (v === 'off') return false;
  return !!(settings || store.settings)[name];
}
// Sparse write: set the key when overridden, DELETE it on 'follow', and delete the whole object when
// it becomes empty. Nothing is written when the value is unchanged (so a no-op save touches no bytes).
function updateContentOverride(acc, name, value) {
  if (!CONTENT_NAMES.includes(name)) throw new Error(`unknown content setting: ${name}`);
  if (!CONTENT_VALUES.includes(value)) throw new Error(`invalid content value: ${value}`);
  if (value === 'follow') {
    if (acc.contentOverride) { delete acc.contentOverride[name]; if (!Object.keys(acc.contentOverride).length) delete acc.contentOverride; }
    return;
  }
  if (!acc.contentOverride) acc.contentOverride = {};
  acc.contentOverride[name] = value;
}
function contentOverrideFor(acc) {
  return { adBlock: !!(acc && acc.contentOverride && acc.contentOverride.adBlock), darkMode: !!(acc && acc.contentOverride && acc.contentOverride.darkMode) };
}

// The two per-view react sites, in ONE place so the global toggle and a per-account override change
// cannot drift apart. `before`/`after` are resolved pairs; only a control whose value MOVED is acted
// on, so a tab that resolves the same is untouched (the equality bar for un-overridden accounts):
//   - dark: enable/disable in that view's isolated world, no reload (measured: it restores exactly).
//   - adBlock -> on: the network predicate is already live through its per-request closure, so only
//     the cosmetic CSS needs re-applying.
//   - adBlock -> off: injected CSS cannot be retracted (src/content.js is frozen and applyToPage
//     discards its insertCSS key), so that ONE view reloads. Never any other view.
function applyContentChange(t, before, after) {
  const wc = t.view.webContents;
  if (!wc || wc.isDestroyed() || !before) return;
  if (before.darkMode !== after.darkMode) { if (after.darkMode) dark.enable(wc); else dark.disable(wc); }
  if (before.adBlock !== after.adBlock) {
    if (after.adBlock) content.applyToPage(wc, { adBlock: true });
    else wc.reload();
  }
}

// The did-finish-load apply for ONE document. A fresh document has no dark engine yet, so "off"
// needs no disable call; the cosmetic layer is applied only when resolved on (applyToPage itself
// also skips managed dashboards, invariant 5 — unchanged).
function applyContentToFreshDocument(wc, acc) {
  content.applyToPage(wc, { adBlock: resolveContent(acc, 'adBlock', store.settings) });
  if (resolveContent(acc, 'darkMode', store.settings)) dark.enable(wc);
}
// Re-resolve every live tab and act only where the value moved. `snapshot` maps tab key -> resolved
// pair captured BEFORE the change; a tab with no snapshot is left alone (it was created inside this
// same change, and its own did-finish-load path already used the new values).
function reactToContentChange(vm, snapshot) {
  for (const t of vm.tabs.values()) {
    const acc = findAccount(t.svc, t.id);
    const after = { adBlock: resolveContent(acc, 'adBlock', store.settings), darkMode: resolveContent(acc, 'darkMode', store.settings) };
    applyContentChange(t, snapshot.get(accountKey(t.svc, t.id)), after);
  }
}
function contentSnapshot(vm) {
  const snap = new Map();
  for (const [key, t] of vm.tabs) {
    const acc = findAccount(t.svc, t.id);
    snap.set(key, { adBlock: resolveContent(acc, 'adBlock', store.settings), darkMode: resolveContent(acc, 'darkMode', store.settings) });
  }
  return snap;
}

// The body of the account-content-override IPC, exported so smoke drives the REAL path (the
// setOrClearDefault precedent). Validates, writes sparse, applies live, emits once.
function setAccountContentOverride(vm, svc, id, name, value) {
  const acc = findAccount(svc, id);
  if (!acc) throw new Error('unknown account');
  if (!CONTENT_NAMES.includes(name)) throw new Error(`unknown content setting: ${name}`);
  if (!CONTENT_VALUES.includes(value)) throw new Error(`invalid content value: ${value}`);
  const snapshot = contentSnapshot(vm);
  updateContentOverride(acc, name, value);
  store.save();
  reactToContentChange(vm, snapshot);
  vm.emitState();
  return {
    value: (acc.contentOverride && acc.contentOverride[name]) || 'follow',
    override: contentOverrideFor(acc),
    resolved: { adBlock: resolveContent(acc, 'adBlock', store.settings), darkMode: resolveContent(acc, 'darkMode', store.settings) },
  };
}

// The app-wide toggle's body, exported for smoke the same way (set-content-setting delegates here).
// 0.11.0: capture what every live tab resolves to BEFORE the change, so the reaction can skip any
// tab whose account overrides the control (its resolved value does not move) — for an account with
// no override this is exactly today's behaviour, tab for tab.
function setGlobalContentSetting(vm, name, value) {
  if (!['adBlock', 'darkMode', 'saveLogins', 'autofill', 'autoUpdate'].includes(name)) throw new Error(`unknown setting: ${name}`);
  const snapshot = (name === 'darkMode' || name === 'adBlock') ? contentSnapshot(vm) : null;
  store.settings[name] = !!value;
  if (name === 'autoUpdate') { store.save(); updater.setAutoUpdate(!!value); vm.emitState(); return !!value; }
  store.save();
  if (snapshot) {
    // dark: one enable/disable call per affected view — no reload. ad-block: cosmetics re-apply on,
    // and only a view whose RESOLVED value fell to off reloads (injected CSS has no other undo).
    reactToContentChange(vm, snapshot);
  }
  vm.emitState();
  return store.settings[name];
}

// ---------- view manager ----------
class ViewManager {
  constructor() {
    this.tabs = new Map(); // key -> {view, svc, id, url, visible, title, lastState, lastActivated} — LIVE views only
    this.session = []; // ordered open-tab set [{svc,id,url,lastActivated}] — includes slept tabs, persisted across restarts
    this.activeKey = null;
    this.window = null;
    this.contentBounds = { x: 0, y: TAB_STRIP_H, width: 800, height: 600 };
    this.modalOpen = false; // while a modal is open, all account views stay hidden (they paint above the chrome DOM)
  }

  attach(win) { this.window = win; }

  // ---- session memory: the open-tab set survives sleeping AND app restarts ----
  sessionEntry(svc, id) { return this.session.find(s => s.svc === svc && s.id === id); }

  trackSession(svc, id, url) {
    let e = this.sessionEntry(svc, id);
    if (!e) { e = { svc, id, url, lastActivated: Date.now() }; this.session.push(e); }
    else if (url) e.url = url;
    this.persistSession();
    return e;
  }

  untrackSession(svc, id) {
    this.session = this.session.filter(s => !(s.svc === svc && s.id === id));
    this.persistSession();
  }

  persistSession() {
    store.openTabs = this.session.map(s => ({ svc: s.svc, id: s.id, url: s.url, lastActivated: s.lastActivated, active: accountKey(s.svc, s.id) === this.activeKey }));
    // coalesce bursts (every tab click calls this) into one write off the hot path
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => { this._persistTimer = null; store.saveSession(); }, 250);
  }

  // Write any pending debounced session state immediately (used on quit).
  flushSession() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    store.saveSession();
  }

  // Restore the tab set from the previous run: most-recent tabs come back live (bounded by warmLimit),
  // the rest appear in the strip asleep and load on click.
  restoreSession() {
    const saved = (store.openTabs || []).filter(s => findAccount(s.svc, s.id) && serviceByKey(s.svc)); // skip deleted accounts and missing services
    if (!saved.length) return 0;
    saved.sort((a, b) => (a.lastActivated || 0) - (b.lastActivated || 0));
    this.session = saved.map(s => ({ svc: s.svc, id: s.id, url: s.url, lastActivated: s.lastActivated || 0 }));
    const limit = Math.max(1, Number(store.settings.warmLimit) || 5);
    const toWake = saved.slice(-limit);
    // Tabs come back warm but nothing is auto-activated: the app lands on Home (the account grid),
    // which is the view the owner wants as the default surface.
    for (const s of toWake) this.create(s.svc, s.id, s.url, { show: false, restoring: true });
    this.activeKey = null;
    this.emitState();
    return toWake.length;
  }

  setBounds(b) {
    this.contentBounds = b;
    for (const t of this.tabs.values()) if (t.visible) t.view.setBounds(this.boundsFor(t));
  }

  // A tab carrying an auto-fill notice reserves room at the top of its view for the banner. The
  // banner lives in the chrome renderer (the view itself is a native child and cannot hold DOM),
  // so the view starts lower for exactly as long as the notice exists (0.9.0).
  boundsFor(t) {
    const b = this.contentBounds;
    if (!t.notice) return b;
    return { ...b, y: b.y + BANNER_H, height: Math.max(0, b.height - BANNER_H) };
  }

  // The per-tab notice the renderer paints above the account view. Always a summary: never a
  // password (the username is the only credential-derived value, as in 0.8.0's chooser).
  setNotice(key, notice) {
    const t = this.tabs.get(key);
    if (!t) return;
    t.notice = notice || null;
    if (this.window && this.window.webContents && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send('account-notice', { key, notice: t.notice });
    }
    if (t.visible) t.view.setBounds(this.boundsFor(t));
  }

  // Hide the banner; the view reclaims the strip immediately.
  clearNotice(key) {
    const t = this.tabs.get(key);
    if (!t || !t.notice) return;
    t.notice = null;
    if (this.window && this.window.webContents && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send('account-notice', { key, notice: null });
    }
    if (t.visible) t.view.setBounds(this.boundsFor(t));
  }

  // Resolve one in-flight fill request for a tab. The preload reports a requestId so a result can
  // never be attributed to the wrong request (or a page that has since navigated).
  settleFill(key, result) {
    const t = this.tabs.get(key);
    if (!t) return null;
    const entry = t.pendingFills.get(result && result.requestId);
    if (!entry) return null;
    t.pendingFills.delete(result.requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return entry;
  }

  setModalOpen(open) {
    this.modalOpen = !!open;
    if (open) {
      // account views are native children that paint ABOVE the chrome DOM: hide them so the modal is reachable
      for (const t of this.tabs.values()) if (t.visible) { t.view.setVisible(false); t.visible = false; }
    } else if (this.activeKey && this.tabs.has(this.activeKey)) {
      const t = this.tabs.get(this.activeKey);
      t.view.setBounds(this.boundsFor(t));
      t.view.setVisible(true);
      t.visible = true;
    }
    this.emitState();
  }

  makeView(svc, id) {
    const acc = findAccount(svc, id);
    const view = new WebContentsView({
      webPreferences: {
        partition: partitionFor(svc, id),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // isolated-world helper: remembers logins you type and fills them back on request.
        // It exposes nothing to the page.
        preload: path.join(__dirname, 'account-preload.js'),
      },
    });
    view.setBackgroundColor('#ffffff'); // sync background: avoids paint-flash on switch (Electron #43293)
    // deny-by-default permissions: embedded pages never get notifications/geo/media without an explicit allowlist
    const ses = view.webContents.session;
    if (!permissionConfigured.has(ses)) {
      permissionConfigured.add(ses);
      const ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write']);
      ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)));
      ses.setPermissionCheckHandler((_wc, permission, _origin) => ALLOWED.has(permission));
    }
    content.attachAdBlock(ses, () => resolveContent(acc, 'adBlock', store.settings)); // per-partition network blocking, resolved PER REQUEST (the account is captured, never scanned — 0.11.0)
    if (acc && acc.proxy) this.applyProxy(view.webContents.session, acc.proxy);
    return view;
  }

  async applyProxy(ses, proxy) {
    try {
      if (!proxy) await ses.setProxy({ mode: 'system' });
      else await ses.setProxy({ mode: 'fixed_servers', proxyRules: proxy });
      await ses.closeAllConnections();
      await ses.clearHostResolverCache();
      await ses.forceReloadProxyConfig();
    } catch (err) { console.error('proxy error:', err.message); }
  }

  create(svc, id, url, opts = {}) {
    const { show = true, label = null } = opts;
    const key = accountKey(svc, id);
    if (this.tabs.has(key)) { if (show) this.activate(key); return key; }
    const service = serviceByKey(svc);
    if (!service) { console.error(`[tabs] cannot open ${svc}::${id} — service definition is missing`); return null; }
    registerAccount(svc, id, label || id);
    const acc = findAccount(svc, id);
    const view = this.makeView(svc, id);
    const tab = { view, svc, id, url: url || service.dashboardUrl, visible: false, title: '', lastState: acc.lastState || 'unknown', lastActivated: Date.now(), notice: null, pendingFills: new Map() };
    this.tabs.set(key, tab);
    this.trackSession(svc, id, tab.url); // tab joins the remembered open set
    this.window.contentView.addChildView(view);
    if (show) this.activate(key);
    // Dark mode is enabled per document from did-navigate below (the isolated world cannot exist
    // before its page does), so there is nothing to attach before the first load.
    view.webContents.loadURL(tab.url).catch(err => console.error(`load failed ${key}:`, err.message));
    view.webContents.on('page-title-updated', (_e, title) => { tab.title = title; this.emitState(); });
    // Escape must reach Home even while the dashboard page has focus (the renderer's keydown
    // handler only sees events when the chrome DOM is focused).
    view.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !this.modalOpen) this.deactivate();
    });
    view.webContents.on('did-finish-load', () => {
      // Ad-block cosmetics + dark mode, resolved for THIS account (0.11.0). Enable dark mode once the
      // document's styles exist: did-navigate fires too early — the dynamic engine finds no
      // stylesheets to transform yet, so enabling there leaves the page white. This fires again after
      // every cross-origin navigation, which is exactly what the isolated-world reset requires — the
      // world (and Dark Reader in it) is gone by then and must be re-injected. Same-document
      // (pushState) routing never reaches here, so it never re-injects. A fresh document never has an
      // engine, so "resolved off" needs no disable call.
      applyContentToFreshDocument(view.webContents, acc);
      // refresh the address strip's key chip from the URL that actually finished loading (0.10.0).
      this.emitState();
    });
    const onNav = (_e, url2) => {
      tab.url = url2;
      // conservative sign-in heuristic: sitting on the service's login page means not signed in.
      // When the service authenticates on a separate host (accounts.google.com, login.live.com,
      // id.heroku.com…) any URL on that host counts as "signing in".
      const loginHost = creds.hostOf(service.loginUrl);
      const onAuthHost = loginHost && loginHost !== creds.hostOf(service.dashboardUrl) && creds.hostOf(url2) === loginHost;
      tab.lastState = (url2.startsWith(service.loginUrl) || onAuthHost) ? 'signin' : 'ok';
      const a = findAccount(svc, id);
      if (a) { a.lastState = tab.lastState; store.save(); }
      this.emitState();
    };
    // Dark mode is (re-)enabled from did-finish-load above, not here: that handler runs after the
    // document's styles exist and after every cross-origin navigation, which is exactly when the
    // isolated-world engine needs (re-)injecting. did-navigate-in-page (pushState) keeps the world,
    // so it deliberately does not re-inject.
    view.webContents.on('did-navigate', (_e, url2) => {
      // A filled-forms notice describes fields that no longer exist after navigating away. Dismiss it
      // so a stale "Undo" can never act on the new page. (Did-navigate-in-page deliberately does not,
      // or a client-side redirect right after fill would immediately drop its own notice.)
      this.clearNotice(key);
      onNav(_e, url2);
    });
    view.webContents.on('did-navigate-in-page', onNav); // dashboards route client-side (pushState) — must track too
    view.webContents.on('did-start-loading', () => this.emitState());
    view.webContents.on('did-stop-loading', () => this.emitState());
    view.webContents.on('render-process-gone', () => {
      console.error(`renderer gone: ${key}`);
      this.hibernate(key); // drop the dead view; partition survives, reopening rehydrates
    });
    view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      if (!/^https?:/i.test(popupUrl)) return { action: 'deny' };
      const key = accountKey(svc, id);
      const tab = this.tabs.get(key);
      if (tab) {
        // target=_blank / OAuth popups load in the SAME account's tab (same partition); the popup window itself is denied
        tab.view.webContents.loadURL(popupUrl).catch(err => console.error('popup load failed:', err.message));
        if (!this.modalOpen) this.activate(key);
      } else {
        this.create(svc, id, popupUrl, { show: !this.modalOpen });
      }
      return { action: 'deny' };
    });
    this.emitState();
    return key;
  }

  activate(key) {
    const tab = this.tabs.get(key);
    if (!tab) return null;
    for (const [k, t] of this.tabs) {
      const vis = k === key && !this.modalOpen; // while a modal is open, views stay hidden
      if (vis && !t.visible) { t.view.setBounds(this.boundsFor(t)); t.view.setVisible(true); t.visible = true; }
      else if (!vis && t.visible) { t.view.setVisible(false); t.visible = false; }
    }
    tab.lastActivated = Date.now();
    this.activeKey = key;
    // Any banner left on a tab the user has now left is stale (Undo would target a page they are no
    // longer looking at). Banner lifetime follows attention: leaving the tab dismisses it.
    for (const [k] of this.tabs) if (k !== key) this.clearNotice(k);
    const se = this.sessionEntry(tab.svc, tab.id);
    if (se) { se.lastActivated = tab.lastActivated; se.url = tab.url; }
    this.persistSession();
    this.enforceWarmLimit();
    this.emitState();
    return key;
  }

  warmTabsSorted() {
    return [...this.tabs.entries()]
      .filter(([k]) => k !== this.activeKey)
      .sort((a, b) => a[1].lastActivated - b[1].lastActivated);
  }

  // Evict least-recently-used tabs down to warmLimit. Each live dashboard costs ~350–375 MB of RAM,
  // so this is the difference between a 600 MB footprint (5 tabs) and unbounded growth that would
  // exhaust memory on machines with many accounts. Sled tabs stay in the strip and resume on click.
  enforceWarmLimit() {
    const limit = Math.max(1, Number(store.settings.warmLimit) || 5);
    const warm = this.warmTabsSorted();
    let excess = warm.length - (limit - (this.activeKey ? 1 : 0)); // the active tab, if any, occupies one slot
    for (const [k] of warm) {
      if (excess <= 0) break;
      this.hibernate(k);
      excess--;
    }
  }

  // Home: hide every account view and show the chrome's grid. Tabs stay LIVE and warm — no teardown,
  // so returning to a tab is instant and its page keeps its place.
  deactivate() {
    for (const t of this.tabs.values()) if (t.visible) { t.view.setVisible(false); t.visible = false; }
    this.activeKey = null;
    this.persistSession();
    this.emitState();
  }

  // Close = remove from the remembered tab set entirely (disappears from the strip).
  closeTab(key) {
    const [svc, id] = key.split('::');
    this.hibernate(key);
    this.untrackSession(svc, id);
    this.emitState();
  }

  hibernate(key) {
    const tab = this.tabs.get(key);
    if (!tab) return;
    for (const entry of tab.pendingFills.values()) { clearTimeout(entry.timer); entry.resolve({ ok: false, reason: 'tab-closed' }); }
    try { this.window.contentView.removeChildView(tab.view); } catch {}
    try { tab.view.webContents.close(); } catch {} // separate: a dead contentView must not skip closing the renderer
    this.tabs.delete(key);
    // Nothing to undo for dark mode here: closing the renderer above discards its isolated world
    // and the Dark Reader inside it. darkmode.js tracks state in a WeakMap, so the dead view is
    // collected with it — no per-tab teardown, and reopening re-enables on its first navigation.
    // NOTE: the session entry is intentionally kept — a slept tab stays in the strip and can be resumed.
    if (this.activeKey === key) {
      this.activeKey = null;
      const remaining = [...this.tabs.values()].sort((a, b) => b.lastActivated - a.lastActivated);
      if (remaining.length) this.activate(accountKey(remaining[0].svc, remaining[0].id));
      else this.persistSession();
    }
    this.emitState();
  }

  hibernateAll() {
    this.activeKey = null; // clear first: otherwise each hibernate() re-activates a neighbour and re-persists
    for (const k of [...this.tabs.keys()]) this.hibernate(k);
    this.persistSession();
  }

  async deleteAccount(svc, id) {
    const key = accountKey(svc, id);
    if (this.tabs.has(key)) {
      for (const entry of this.tabs.get(key).pendingFills.values()) { clearTimeout(entry.timer); entry.resolve({ ok: false, reason: 'tab-closed' }); }
      try { this.window.contentView.removeChildView(this.tabs.get(key).view); this.tabs.get(key).view.webContents.close(); } catch {}
      this.tabs.delete(key);
    }
    this.untrackSession(svc, id); // also drop it from the remembered tab set
    try { creds.removeForAccount(svc, id); } catch {} // a deleted account's captured login must not linger for a future account with the same id
    store.accounts = store.accounts.filter(a => !(a.svc === svc && a.id === id));
    store.save();
    try {
      const ses = session.fromPartition(partitionFor(svc, id));
      await ses.clearStorageData(); // no options = all storage types (websql/domstorage are not valid enum values)
    } catch (err) { console.error('clearStorageData failed:', err.message); }
    // best-effort dir removal (may fail while Chromium holds handles; leftover is inert once registry entry is gone)
    try { fs.rmSync(partitionDir(svc, id), { recursive: true, force: true }); } catch {}
    if (this.activeKey === key) this.activeKey = null;
    this.emitState();
  }

  async updateAccount(svc, id, patch) {
    const acc = findAccount(svc, id);
    if (!acc) return;
    if (typeof patch.label === 'string' && patch.label.trim()) { acc.label = patch.label.trim(); }
    if (typeof patch.proxy === 'string') {
      acc.proxy = patch.proxy.trim();
      const tab = this.tabs.get(accountKey(svc, id));
      if (tab) await this.applyProxy(tab.view.webContents.session, acc.proxy);
    }
    store.save();
    this.emitState();
  }

  emitState() {
    if (!this.window || !this.window.webContents) return;
    const loginList = credSummaries(); // one decryption per state emit, not one per account
    // The key chip in the address strip counts saved logins for the ACTIVE tab's live host (0.10.0).
    // Recomputed here, so it is fresh after every navigation and every tab activation, and it is
    // computed for the active tab only — the other tabs refresh when they are activated.
    let siteLogins = null;
    const activeTab = this.activeKey ? this.tabs.get(this.activeKey) : null;
    if (activeTab && !activeTab.view.webContents.isDestroyed()) {
      const liveUrl = activeTab.view.webContents.getURL();
      const { host, rows } = siteLoginRows(activeTab.svc, activeTab.id, liveUrl, loginList);
      siteLogins = { key: this.activeKey, host, count: host ? rows.length : 0 };
    }
    this.window.webContents.send('tabs-state', {
      activeKey: this.activeKey,
      siteLogins,
      warmLimit: store.settings.warmLimit,
      registry: store.accounts.map(a => ({
        ...a,
        key: accountKey(a.svc, a.id),
        hasToken: !!tokens.tokenMeta(accountKey(a.svc, a.id)),
        status: statusCache.get(accountKey(a.svc, a.id)) || null,
        loginCount: accountLoginSummaries(a.svc, a.id, loginList).length, // "has saved login" indicator
        noAutoFill: !!a.noAutoFill,
        // 0.11.0: what each control ACTUALLY resolves to for this account, and whether the account
        // overrides it — the gear window's worded state and the Home card's marker read these.
        contentResolved: { adBlock: resolveContent(a, 'adBlock', store.settings), darkMode: resolveContent(a, 'darkMode', store.settings) },
        contentOverridden: contentOverrideFor(a),
      })), // live registry projection for the home grid (token presence + status summaries; never raw tokens)
      groupTabs: !!store.settings.groupTabs,
      collapsed: store.settings.collapsed || [],
      stripCollapsed: store.settings.stripCollapsed || [],
      settings: { ...store.settings },
      blocked: content.stats.blocked,
      credCount: creds.stats().total,
      services: allServices(), // includes user-added services so the renderer stays in sync
      // the strip shows the whole remembered open set: live tabs AND slept ones (resume on click)
      tabs: this.session.map(s => {
        const k = accountKey(s.svc, s.id);
        const t = this.tabs.get(k);
        const a = findAccount(s.svc, s.id) || {};
        return {
          key: k, svc: s.svc, id: s.id, label: a.label || s.id, colorIdx: a.colorIdx || 0,
          title: t ? t.title : '', url: t ? t.url : s.url,
          live: !!t, visible: t ? t.visible : false,
          canGoBack: !!(t && !t.view.webContents.isDestroyed() && t.view.webContents.navigationHistory.canGoBack()),
          canGoForward: !!(t && !t.view.webContents.isDestroyed() && t.view.webContents.navigationHistory.canGoForward()),
          loading: !!(t && !t.view.webContents.isDestroyed() && t.view.webContents.isLoading()),
          lastState: t ? t.lastState : (a.lastState || 'unknown'),
        };
      }),
    });
  }

  // Browser-style navigation for the ACTIVE tab. `navigate` accepts http(s) only — the address bar
  // must never become a way to launch other schemes from the chrome.
  nav(action, url) {
    const t = this.tabs.get(this.activeKey);
    if (!t || t.view.webContents.isDestroyed()) return false;
    const wc = t.view.webContents;
    switch (action) {
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'stop': wc.stop(); break;
      case 'dashboard': { const svc = serviceByKey(t.svc); if (svc) wc.loadURL(svc.dashboardUrl).catch(() => {}); break; }
      case 'navigate': {
        let target = String(url || '').trim();
        if (!target) return false;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = `https://${target}`; // "example.com/path" → https
        let parsed;
        try { parsed = new URL(target); } catch { return false; }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
        wc.loadURL(parsed.href).catch(err => console.error(`navigate failed ${this.activeKey}:`, err.message));
        break;
      }
      default: return false;
    }
    this.emitState();
    return true;
  }

  snapshotMemory() {
    // Summing workingSetSize over-reports badly: Chromium maps shared pages (the framework binary and
    // friends) into every process, so they are counted once per process — with 10 processes that read
    // 1,388 MB while Windows/Task Manager reported 803 MB private. privateBytes is the number that
    // matches Task Manager, so it is what the UI shows; the working-set total is kept for reference.
    const metrics = app.getAppMetrics();
    let totalWS = 0; let totalPrivate = 0; const byType = {};
    for (const m of metrics) {
      totalWS += (m.memory && m.memory.workingSetSize) || 0;
      totalPrivate += (m.memory && m.memory.privateBytes) || 0;
      byType[m.type] = (byType[m.type] || 0) + 1;
    }
    const privateMB = Math.round(totalPrivate / 1024);
    const workingSetMB = Math.round(totalWS / 1024);
    return {
      totalWorkingSetKB: totalWS,
      workingSetMB,
      privateMB,
      totalMB: privateMB || workingSetMB, // privateBytes is Windows-only; fall back elsewhere
      processes: byType,
      processCount: metrics.length,
      liveTabs: this.tabs.size,
    };
  }
}

// ---------- benchmark mode (unchanged contract): electron . --spike ----------
async function runSpike() {
  const argIdx = process.argv.indexOf('--counts');
  const counts = argIdx > -1 ? process.argv[argIdx + 1].split(',').map(Number) : [5, 10, 20, 30];
  const report = { date: new Date().toISOString(), platform: process.platform, electron: process.versions.electron, chrome: process.versions.chrome, settleMs: SETTLE_MS, runs: [] };

  const win = new BaseWindow({ width: 1280, height: 800, show: false });
  const vm = new ViewManager();
  vm.attach(win);

  const waitLoad = (tab, timeoutMs = 45000) => {
    const wc = tab.view.webContents;
    return new Promise(resolve => {
      if (!wc.isLoadingMainFrame()) return resolve();
      const timer = setTimeout(done, timeoutMs);
      function done() { clearTimeout(timer); wc.removeListener('did-finish-load', done); wc.removeListener('did-fail-load', done); resolve(); }
      wc.once('did-finish-load', done);
      wc.once('did-fail-load', done);
    });
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let comboIdx = 0;
  const nextCombo = () => {
    const svc = SERVICES[comboIdx % SERVICES.length];
    const n = Math.floor(comboIdx / SERVICES.length) + 1;
    comboIdx++;
    return { svc, id: `acc${n}` };
  };

  for (const count of counts) {
    const created = [];
    while (vm.tabs.size < count) {
      const { svc, id } = nextCombo();
      vm.create(svc.key, id, svc.loginUrl, { show: false });
      created.push({ key: accountKey(svc.key, id), svc: svc.key, id });
    }
    const tLoads0 = Date.now();
    await Promise.all(created.map(c => waitLoad(vm.tabs.get(c.key))));
    const loadMs = Date.now() - tLoads0;
    await sleep(SETTLE_MS);

    const live = vm.snapshotMemory();
    report.runs.push({ phase: 'live-all-visible', count, loadMs, ...live });
    console.log(`[spike] count=${count} live(all visible)=${live.totalMB}MB procs=${JSON.stringify(live.processes)} loadWallMs=${loadMs}`);

    const keys = [...vm.tabs.keys()];
    for (const k of keys.slice(1)) { vm.tabs.get(k).view.setVisible(false); vm.tabs.get(k).visible = false; }
    await sleep(3000);
    const hidden = vm.snapshotMemory();
    report.runs.push({ phase: 'live-only-one-visible', count, ...hidden });
    console.log(`[spike] count=${count} live(one visible)=${hidden.totalMB}MB`);

    vm.hibernateAll();
    await sleep(2000);
    const hibernated = vm.snapshotMemory();
    report.runs.push({ phase: 'hibernated', count, ...hibernated });
    console.log(`[spike] count=${count} hibernated=${hibernated.totalMB}MB`);
  }

  const lastCount = counts[counts.length - 1];
  const restoreKeys = [];
  const t0 = Date.now();
  for (let i = 0; i < lastCount; i++) {
    const { svc, id } = nextCombo();
    vm.create(svc.key, id, svc.loginUrl, { show: false });
    restoreKeys.push(accountKey(svc.key, id));
  }
  await Promise.all(restoreKeys.map(k => vm.tabs.get(k) ? waitLoad(vm.tabs.get(k)) : Promise.resolve()));
  const restoreMs = Date.now() - t0;
  await sleep(SETTLE_MS);
  const restored = vm.snapshotMemory();
  report.runs.push({ phase: 'restored-from-disk', count: restoreKeys.length, restoreMs, ...restored });
  console.log(`[spike] restore of ${restoreKeys.length} partitions: ${restoreMs}ms load, ${restored.totalMB}MB after settle`);

  fs.writeFileSync(path.join(__dirname, '..', 'spike-report.json'), JSON.stringify(report, null, 2));
  console.log('[spike] report written to spike-report.json');
  app.quit();
}

// ---------- smoke test: create fresh accounts, verify, quit ----------
async function runSmoke() {
  const win = new BaseWindow({ width: 1280, height: 800, show: false });
  const vm = new ViewManager();
  vm.attach(win);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const results = { mode: 'create', checks: [] };
  const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

  vm.create('netlify', 'a1', SERVICES.find(s => s.key === 'netlify').loginUrl, { show: false });
  vm.create('supabase', 'a1', SERVICES.find(s => s.key === 'supabase').loginUrl, { show: false });
  vm.create('vercel', 'a1', SERVICES.find(s => s.key === 'vercel').loginUrl, { show: false });

  await sleep(15000); // let pages load and partitions hit disk

  check('registry-has-3-accounts', store.accounts.length === 3, JSON.stringify(store.accounts.map(a => `${a.svc}/${a.id}`)));
  const partDirs = ['netlify', 'supabase', 'vercel'].map(s => partitionDir(s, 'a1'));
  const dirsExist = partDirs.filter(p => fs.existsSync(p));
  check('partition-dirs-on-disk', dirsExist.length === 3, `${dirsExist.length}/3: ${dirsExist.join(', ')}`);
  const accountsFile = fs.existsSync(userDataPath('accounts.json'));
  check('accounts-json-written', accountsFile, userDataPath('accounts.json'));
  const mem = vm.snapshotMemory();
  check('live-tabs', mem.liveTabs === 3, `${mem.totalMB}MB`);

  // browser-style navigation on the active tab (address bar, back, dashboard) — http(s) only
  const key = accountKey('netlify', 'a1');
  vm.activate(key);
  const urlOf = () => vm.tabs.get(key).view.webContents.getURL();
  const waitFor = async (pred, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(250); } return pred(); };
  check('nav-rejects-javascript-scheme', vm.nav('navigate', 'javascript:alert(1)') === false && !urlOf().startsWith('javascript:'));
  check('nav-rejects-file-scheme', vm.nav('navigate', 'file:///C:/Windows') === false && !urlOf().startsWith('file:'));
  check('nav-rejects-empty', vm.nav('navigate', '   ') === false);
  vm.nav('navigate', 'example.com'); // bare host → https
  check('nav-address-goes-there', await waitFor(() => /^https:\/\/example\.com\/?$/.test(urlOf())), urlOf());
  check('nav-can-go-back', vm.tabs.get(key).view.webContents.navigationHistory.canGoBack());
  vm.nav('back');
  check('nav-back-returns', await waitFor(() => /netlify\.com/.test(urlOf())), urlOf());
  vm.nav('navigate', 'https://example.org/');
  await waitFor(() => /example\.org/.test(urlOf()));
  vm.nav('dashboard');
  check('nav-dashboard-returns-to-service', await waitFor(() => /app\.netlify\.com/.test(urlOf())), urlOf());
  check('nav-noop-without-active-tab', (() => { const k = vm.activeKey; vm.activeKey = null; const r = vm.nav('reload'); vm.activeKey = k; return r === false; })());

  fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(results, null, 2));
  app.exit(results.checks.every(c => c.ok) ? 0 : 1);
}

// ---------- smoke tokens: DPAPI round-trip + validation error path (no real token needed) ----------
async function runSmokeTokens() {
  const results = { mode: 'tokens', checks: [] };
  const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`[smoke:tokens] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const { safeStorage } = require('electron');
  check('safeStorage-available', safeStorage.isEncryptionAvailable());
  const rt = await tokens.setToken('vercel::toktest', 'vcp_fake_token_1234567890');
  void rt;
  const back = await tokens.getToken('vercel::toktest');
  check('roundtrip', back === 'vcp_fake_token_1234567890');
  check('ciphertext-not-plaintext', !fs.readFileSync(path.join(app.getPath('userData'), 'tokens.json'), 'utf8').includes('vcp_fake_token'));
  // real-network validation error path: a fake token must be rejected as TOKEN_INVALID
  try {
    await PROVIDERS.vercel.validate('vcp_fake_token_1234567890');
    check('fake-token-rejected', false, 'API accepted a fake token?!');
  } catch (err) {
    check('fake-token-rejected', err.message === 'TOKEN_INVALID', `err=${err.message}`);
  }
  await tokens.clearToken('vercel::toktest');
  check('clear', (await tokens.getToken('vercel::toktest')) === null);
  // every provider added in 0.4.0 must reject a fake token cleanly (TOKEN_INVALID), never accept or crash
  const fakes = { fly: 'fo1_fake0000000000000000000000000000', heroku: 'HRKU-fake-0000', digitalocean: 'dop_v1_fake0000', neon: 'napi_fake0000', gitlab: 'glpat-fake000000000000', npm: 'npm_fake000000000000000000000000000000', dockerhub: 'nobody-mam:dckr_pat_fake0000', huggingface: 'hf_fake000000000000000000000000000', stripe: 'rk_test_fake000000000000000000' };
  for (const [key, fake] of Object.entries(fakes)) {
    try { await PROVIDERS[key].validate(fake); check(`fake-token-rejected:${key}`, false, 'API accepted a fake token?!'); }
    catch (err) { check(`fake-token-rejected:${key}`, err.message === 'TOKEN_INVALID', `err=${err.message}`); }
  }
  check('dockerhub-needs-username', await PROVIDERS.dockerhub.validate('no-colon-here').then(() => false, err => /username:token/.test(err.message)));
  fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(results, null, 2));
  app.exit(results.checks.every(c => c.ok) ? 0 : 1);
}

// ---------- smoke services: every built-in service definition is sane and its login page really
// loads inside an isolated partition, landing on a host the credential origin guard accepts ----------
async function runSmokeServices() {
  const results = { mode: 'services', checks: [] };
  const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`[smoke:services] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const keys = SERVICES.map(s => s.key);
  check('unique-keys', new Set(keys).size === keys.length, `${keys.length} services`);
  check('definitions-complete', SERVICES.every(s => s.name && /^https:\/\//.test(s.dashboardUrl) && /^https:\/\//.test(s.loginUrl) && /^https:\/\//.test(s.signupUrl) && /^#[0-9a-f]{6}$/i.test(s.color) && ['ok', 'warn', 'one-per-person'].includes(s.multiAccountPolicy) && typeof s.category === 'string' && s.category));
  check('partition-ids-safe', SERVICES.every(s => /^[a-z0-9_-]+$/.test(s.key)), keys.join(','));
  check('extra-hosts-are-specific', SERVICES.every(s => (s.extraHosts || []).every(h => /^[a-z0-9.-]+\.[a-z]+$/.test(h) && h.split('.').length >= 3)));
  check('extra-hosts-in-guard', serviceHosts('dockerhub').includes('login.docker.com') && originAllowed('dockerhub', 'https://login.docker.com/u/login?x=1') && !originAllowed('dockerhub', 'https://evil.example/'));

  const win = new BaseWindow({ width: 1280, height: 800, show: false });
  const vm = new ViewManager();
  vm.attach(win);
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const targets = SERVICES.filter(s => !only.length || only.includes(s.key));
  const loadOne = svc => new Promise(resolve => {
    const key = vm.create(svc.key, 'probe', svc.loginUrl, { show: false });
    const tab = vm.tabs.get(key);
    const wc = tab.view.webContents;
    let settled = false;
    const finish = (status, detail) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status, detail, url: wc.getURL(), title: wc.getTitle() }); };
    const timer = setTimeout(() => finish('timeout', ''), 30000);
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain && code !== -3) finish('fail', `${code} ${desc} ${url}`); });
    wc.on('did-finish-load', () => setTimeout(() => finish('ok', ''), 1500)); // let client-side redirects settle
  });
  for (const svc of targets) {
    const r = await loadOne(svc);
    const host = creds.hostOf(r.url);
    const guardOk = originAllowed(svc.key, r.url);
    const httpOk = r.status === 'ok' && /^https:\/\//.test(r.url);
    check(`login-loads:${svc.key}`, httpOk && guardOk, `${r.status} ${r.url} "${r.title}"${guardOk ? '' : ` — host ${host} is outside the credential guard`}${r.detail ? ` ${r.detail}` : ''}`);
  }
  fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(results, null, 2));
  app.exit(results.checks.every(c => c.ok) ? 0 : 1);
}

// ---------- smoke creds: CSV import, per-account remember/recall, encryption at rest ----------
async function runSmokeCreds() {
  const results = { mode: 'creds', checks: [] };
  const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`[smoke:creds] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const csv = path.join(app.getPath('temp'), `mam-creds-${process.pid}.csv`);
  fs.writeFileSync(csv, 'url,username,password\nhttps://vercel.com/login,alice@example.com,hunter2\nhttps://app.netlify.com/login,bob@example.com,s3cret\n');
  try {
    const r = creds.importFromCsv(csv);
    check('csv-import', r.added === 2 && r.total >= 2, JSON.stringify({ added: r.added, total: r.total }));

    const rem = creds.rememberForAccount('vercel', 'acc9', { url: 'https://vercel.com/login', username: 'typed@example.com', password: 'typed-pw' });
    check('remember-for-account', rem.saved === true);
    const got = creds.forAccount('vercel', 'acc9', 'https://vercel.com/login');
    check('recall-bound-to-account', !!got && got.username === 'typed@example.com' && got.password === 'typed-pw');

    // an account with no saved login falls back to an imported credential for the same host
    const fb = creds.forAccount('vercel', 'never-signed-in', 'https://vercel.com/login');
    check('host-fallback-from-import', !!fb && fb.username === 'alice@example.com', fb ? fb.username : 'none');

    // a second username captured for the same account is a SECOND candidate — no silent first-wins
    creds.rememberForAccount('vercel', 'acc9', { url: 'https://vercel.com/login', username: 'second@example.com', password: 'second-pw' });
    const cands = creds.candidatesForAccount('vercel', 'acc9', 'https://vercel.com/login');
    check('candidates-include-both-usernames', cands.length === 3 && cands.filter(c => c.accountKey === 'vercel::acc9').length === 2 && cands.every(c => !!c.id), `${cands.length} candidates (2 own + 1 imported)`);
    check('ambiguous-own-never-guesses', creds.credentialForAccount('vercel', 'acc9', 'https://vercel.com/login') === null);
    const pick = cands.find(c => c.username === 'second@example.com');
    creds.setDefaultForAccount(pick.id, 'vercel', 'acc9', 'https://vercel.com/login');
    check('chosen-default-wins', (creds.credentialForAccount('vercel', 'acc9', 'https://vercel.com/login') || {}).username === 'second@example.com');
    // the chooser projection must carry no password — invariant 3
    const sums = creds.candidateSummariesForAccount('vercel', 'acc9', 'https://vercel.com/login');
    check('chooser-summaries-have-no-passwords', sums.length === 3 && sums.every(c => !('password' in c) && !!c.id && c.isDefault === (c.username === 'second@example.com')), `${sums.length} summaries`);
    check('delete-credential', creds.deleteCredential(pick.id) === true && !creds.listCredentials().some(c => c.id === pick.id) && (creds.credentialForAccount('vercel', 'acc9', 'https://vercel.com/login') || {}).username === 'typed@example.com');
    check('manager-list-has-no-passwords', creds.listCredentials().every(c => !('password' in c) && !!c.id));

    // two imported logins on one host are ambiguous: autofill asks instead of guessing
    const csv2 = path.join(app.getPath('temp'), `mam-creds2-${process.pid}.csv`);
    fs.writeFileSync(csv2, 'url,username,password\nhttps://vercel.com/login,carol@example.com,carol-pw\n');
    try {
      const r2 = creds.importFromCsv(csv2);
      check('second-import-added', r2.added === 1, JSON.stringify(r2));
      check('ambiguous-import-never-guesses', creds.credentialForAccount('vercel', 'third-account', 'https://vercel.com/login') === null);
    } finally { try { fs.rmSync(csv2, { force: true }); } catch {} }

    // deleting an account drops its captured logins AND its defaults
    creds.rememberForAccount('vercel', 'acc9', { url: 'https://vercel.com/login', username: 'third@example.com', password: 'third-pw' });
    creds.setDefaultForAccount(creds.candidatesForAccount('vercel', 'acc9', 'https://vercel.com/login').find(c => c.username === 'third@example.com').id, 'vercel', 'acc9', 'https://vercel.com/login');
    const removed = creds.removeForAccount('vercel', 'acc9');
    check('account-delete-drops-captures-and-defaults', removed === 2 && !creds.listCredentials().some(c => (c.accountKey === 'vercel::acc9') || (c.defaultForAccounts || []).includes('vercel::acc9')), `removed=${removed}`);

    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'credentials.json'), 'utf8');
    check('encrypted-at-rest', !raw.includes('hunter2') && !raw.includes('typed-pw'));

    // ---------- 0.9.0: the per-account projection, the manager projection, clear semantics ----------
    // Rebuild a clean fixture: one captured login per account + two imports on the same site (the
    // ambiguity case the chooser exists for).
    creds.clearAll();    store.accounts = [];
    registerAccount('vercel', 'team-a', 'Team A');
    registerAccount('vercel', 'team-b', 'Team B');
    registerAccount('netlify', 'site', 'Site');
    creds.rememberForAccount('vercel', 'team-a', { url: 'https://vercel.com/login', username: 'a@example.com', password: 'pw-a' });
    creds.rememberForAccount('vercel', 'team-b', { url: 'https://vercel.com/login', username: 'b@example.com', password: 'pw-b' });
    const csv3 = path.join(app.getPath('temp'), `mam-creds3-${process.pid}.csv`);
    fs.writeFileSync(csv3, 'url,username,password\nhttps://vercel.com/login,shared@example.com,shared-pw\nhttps://vercel.com/login,carol@example.com,carol-pw\n');
    try {
      creds.importFromCsv(csv3);
      const aLogins = accountLoginSummaries('vercel', 'team-a');
      check('per-account-list-is-its-own-logins',
        aLogins.some(l => l.username === 'a@example.com') && aLogins.some(l => l.username === 'shared@example.com')
          && !aLogins.some(l => l.username === 'b@example.com'),
        aLogins.map(l => `${l.username}${l.own ? '*' : ''}`).join(','));
      check('per-account-list-has-no-passwords',
        aLogins.every(l => !('password' in l))
          && !JSON.stringify(aLogins).includes('pw-a') && !JSON.stringify(aLogins).includes('hero-pw'),
        `${aLogins.length} summaries`);
      const rows = managerRows();
      check('manager-list-carries-accounts-and-services',
        rows.length === 4
          && rows.every(r => Array.isArray(r.accounts) && Array.isArray(r.serviceKeys) && !('password' in r))
          && rows.find(r => r.username === 'a@example.com').accounts.map(a => a.key).join() === 'vercel::team-a',
        `${rows.length} rows`);
      check('manager-rows-have-no-passwords',
        rows.every(r => !('password' in r) && !JSON.stringify(r).includes('pw-a') && !JSON.stringify(r).includes('shared-pw')));
      // what emitState puts on a rail row: a count for the badge (and the account's opt-out flag)
      check('rail-badge-counts-per-account',
        accountLoginSummaries('vercel', 'team-a').length === 3 && accountLoginSummaries('netlify', 'site').length === 0,
        `team-a=${accountLoginSummaries('vercel', 'team-a').length} netlify=${accountLoginSummaries('netlify', 'site').length}`);

      // set-default leaves OTHER rows' defaults untouched (the manager used to strip them client-side)
      const rowA = rows.find(r => r.username === 'a@example.com');
      const rowShared = rows.find(r => r.username === 'shared@example.com');
      setOrClearDefault(rowA.id, 'vercel', 'team-a', 'https://vercel.com/login');
      setOrClearDefault(rowShared.id, 'vercel', 'team-a', 'https://vercel.com/login');
      let now = managerRows();
      check('star-markers-come-from-main',
        now.find(r => r.username === 'a@example.com').defaultForAccounts.length === 0
          && now.find(r => r.username === 'shared@example.com').defaultForAccounts.includes('vercel::team-a'),
        now.map(r => `${r.username}:${r.defaultForAccounts.join('|')}`).join(' '));
      // row B keeps ITS default while row A is re-pointed: one row's ★ never disturbs another's
      setOrClearDefault(now.find(r => r.username === 'b@example.com').id, 'vercel', 'team-b', 'https://vercel.com/login');
      setOrClearDefault(managerRows().find(r => r.username === 'carol@example.com').id, 'vercel', 'team-b', 'https://vercel.com/login');
      now = managerRows();
      check('set-default-leaves-other-rows-defaults-intact',
        now.find(r => r.username === 'b@example.com').defaultForAccounts.length === 0
          && now.find(r => r.username === 'carol@example.com').defaultForAccounts.join() === 'vercel::team-b');

      // null id = explicit CLEAR: clears that account's default and cannot set one anywhere
      setOrClearDefault(null, 'vercel', 'team-b', 'https://vercel.com/login');
      now = managerRows();
      check('clear-default-with-null-id-clears', now.every(r => !r.defaultForAccounts.includes('vercel::team-b')),
        now.map(r => `${r.username}:${r.defaultForAccounts.join('|')}`).join(' '));
      let threw = false;
      try { setOrClearDefault(null, '', '', ''); } catch { threw = true; }
      check('clear-default-needs-an-account', threw);
      // ...and the OTHER account's ★ survived that clear: clearing is per account, never global
      check('clear-default-is-scoped-to-one-account',
        managerRows().find(r => r.username === 'shared@example.com').defaultForAccounts.join() === 'vercel::team-a');
      setOrClearDefault(null, 'vercel', 'team-a', 'https://vercel.com/login');
      check('clear-default-cannot-invent-a-default', managerRows().every(r => r.defaultForAccounts.length === 0));

      // fill fallback: a service whose dashboard and sign-in sit on DIFFERENT hosts (Heroku:
      // dashboard.heroku.com vs id.heroku.com). A login saved for the sign-in host has no live-host
      // candidate on the dashboard — the fallback resolves it through the service's own hosts...
      creds.rememberForAccount('heroku', 'main', { url: 'https://id.heroku.com/login', username: 'hero@example.com', password: 'hero-pw' });
      const atDashboard = fillCandidatesFor('heroku', 'main', 'https://dashboard.heroku.com/apps');
      check('fill-fallback-resolves-same-service-login',
        atDashboard.source === 'service' && atDashboard.candidates.length === 1
          && atDashboard.candidates[0].username === 'hero@example.com',
        `${atDashboard.source}:${atDashboard.candidates.map(c => c.username).join(',')}`);
      const atLogin = fillCandidatesFor('heroku', 'main', 'https://id.heroku.com/login');
      check('fill-live-host-preferred', atLogin.source === 'live' && atLogin.candidates.every(c => creds.hostRelated(c.host, 'id.heroku.com')));
      // ...but a FOREIGN live host is refused outright (D14): originAllowed is the gate every fill
      // passes first, and the fallback only ever draws from serviceHosts().
      check('fill-fallback-refuses-foreign-host',
        originAllowed('heroku', 'https://accounts.google.com/signin') === false
          && originAllowed('heroku', 'https://dashboard.heroku.com.evil.example/') === false
          && fillCandidatesFor('heroku', 'main', 'https://dashboard.heroku.com/apps').candidates
            .every(c => serviceHosts('heroku').some(h => creds.hostRelated(c.host, h))));
      // "Use from the manager" on a DASHBOARD: the login belongs to the sign-in host, so a default set
      // with the page's own live host would be refused by credentials.js. useAsDefault must pick the
      // service host that really holds the candidate.
      const heroId = fillCandidatesFor('heroku', 'main', 'https://dashboard.heroku.com/apps').candidates[0].id;
      let useOk = true; let useErr = '';
      try { useAsDefault('heroku', 'main', heroId); } catch (err) { useOk = false; useErr = err.message; }
      check('use-from-dashboard-sets-the-default', useOk
        && managerRows().find(r => r.id === heroId).defaultForAccounts.includes('heroku::main'), useErr);
      // the fallback ladder must agree with the frozen credentials.js ladder on one host
      check('fallback-ladder-matches-frozen-ladder', ['team-a', 'team-b', 'nobody', 'team-c'].every(id => {
        const live = creds.credentialForAccount('vercel', id, 'https://vercel.com/login');
        const viaFallback = resolveAmong(fillCandidatesFor('vercel', id, 'https://vercel.com/login').candidates, accountKey('vercel', id), null);
        return (live && live.id) === (viaFallback && viaFallback.id);
      }));

      // ---------- auto-fill plan: opt-out, ambiguity, masters ----------
      const teamA = findAccount('vercel', 'team-a');
      check('autofill-plan-fills-unambiguous', (() => {
        const plan = autoFillPlan('vercel', 'team-b', 'https://vercel.com/login');
        return plan.kind === 'fill' && plan.username === 'b@example.com';
      })(), JSON.stringify(autoFillPlan('vercel', 'team-b', 'https://vercel.com/login')));
      check('autofill-plan-honours-per-account-opt-out', (() => {
        const plan = autoFillPlan('vercel', 'team-a', 'https://vercel.com/login', { account: { noAutoFill: true } });
        return plan.kind === 'skip' && plan.reason === 'account-opt-out';
      })());
      check('autofill-plan-honours-global-master', (() => {
        const plan = autoFillPlan('vercel', 'team-a', 'https://vercel.com/login', { account: teamA, settings: { autofill: false } });
        return plan.kind === 'skip' && plan.reason === 'autofill-off';
      })());
      check('autofill-plan-refuses-foreign-host',
        autoFillPlan('vercel', 'team-a', 'https://accounts.google.com/signin', { account: teamA }).reason === 'foreign-host');
      check('autofill-plan-offers-chooser-on-ambiguity', (() => {
        const plan = autoFillPlan('vercel', 'team-c', 'https://vercel.com/login');
        return plan.kind === 'choose' && plan.choices.length === 2 && plan.choices.every(c => !('password' in c));
      })(), JSON.stringify(autoFillPlan('vercel', 'team-c', 'https://vercel.com/login')).slice(0, 140));
      check('autofill-plan-is-silent-with-nothing-saved',
        autoFillPlan('netlify', 'site', 'https://app.netlify.com/login').reason === 'no-login');
      check('choose-summaries-carry-no-passwords', (() => {
        const plan = autoFillPlan('vercel', 'team-c', 'https://vercel.com/login');
        return plan.kind === 'choose' && !JSON.stringify(plan.choices).includes('shared-pw') && !JSON.stringify(plan.choices).includes('carol-pw');
      })());

      // ---------- 0.10.0: the per-site picker ----------
      // The fixture above: team-a holds a@example.com plus the two shared imports, team-b owns
      // b@example.com, netlify's account owns nothing. A picker on vercel.com for team-a shows the
      // account's own capture AND every shared import on the live host — never a sibling's capture
      // (invariant 1: a capture belongs to the account that made it).
      const siteA = siteLoginRows('vercel', 'team-a', 'https://vercel.com/login');
      check('site-list-includes-shared-imports-from-another-account',
        siteA.rows.map(r => r.username).sort().join() === ['a@example.com', 'carol@example.com', 'shared@example.com'].join()
          && !siteA.rows.some(r => r.username === 'b@example.com'),
        `${siteA.host}: ${siteA.rows.map(r => `${r.username}${r.accountLabel ? `[${r.accountLabel}]` : r.own ? '[own]' : '[import]'}`).join(',')}`);
      check('site-list-rows-have-no-password-key',
        siteA.rows.every(r => !('password' in r) && !JSON.stringify(r).includes('shared-pw') && !JSON.stringify(r).includes('pw-a')),
        `${siteA.rows.length} rows: ${JSON.stringify(Object.keys(siteA.rows[0] || {}))}`);
      // An import is shared (no owning account); a capture made by another account is that account's
      // login and is neither listed nor copyable from here (invariant 1, the 0.9.0 boundary).
      check('site-list-scope-is-own-captures-plus-shared-imports',
        siteA.rows.filter(r => r.accountLabel === null).length === 3
          && siteA.rows.find(r => r.username === 'a@example.com').own === true
          && siteA.rows.filter(r => r.username === 'shared@example.com' || r.username === 'carol@example.com').every(r => r.own === false && r.accountLabel === null),
        siteA.rows.map(r => `${r.username}:${r.own ? 'own' : 'shared'}`).join(' '));
      // D14: a copy is refused when the tab is not on the service's own site ...
      const offSite = copyCredentialField(siteA.rows[0].id, 'password', 'vercel', 'team-a', 'https://accounts.google.com/signin');
      check('copy-refused-off-site', offSite.ok === false && offSite.reason === 'foreign-host', `reason=${offSite.reason}`);
      // ... and an unknown id never yields a secret
      const unknown = copyCredentialField('no-such-credential', 'password', 'vercel', 'team-a', 'https://vercel.com/login');
      check('copy-refused-unknown-id', unknown.ok === false && unknown.reason === 'unknown-id', `reason=${unknown.reason}`);
      // a sibling account's capture is never available here, even on its own site (invariant 1)
      const otherAcct = creds.loadAll().find(c => c.accountKey === 'vercel::team-b');
      const sibling = copyCredentialField(otherAcct.id, 'password', 'vercel', 'team-a', 'https://vercel.com/login');
      check('copy-refused-another-accounts-capture', sibling.ok === false && sibling.reason === 'other-account', `reason=${sibling.reason}`);
      clipboard.clear();
      // WARM-UP WRITE (required): on this machine the first writeText after clear() in a fresh
      // process does not yet round-trip through readText — this sentinel is what makes the very
      // first read-back reliable at all (proved 2026-11-03: removing it made every copy check fail).
      // A cold machine (the day's first run) can still be slow even with the warm-up, hence the poll.
      clipboard.writeText('sentinel-before-copy');
      // the real copy path: main writes the clipboard, and the answer is a label — never the secret.
      // A cold machine can take a moment before the Win32 clipboard returns what was just written
      // (observed 2026-11-03: the day's first suite run read back stale values; every rerun passed),
      // so poll the read-back and retry the write once — a genuine write regression still fails hard.
      const clipboardSettles = async (doWrite, expected) => {
        let last = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          last = doWrite();
          const deadline = Date.now() + 2500;
          while (Date.now() < deadline) {
            if (clipboard.readText() === expected) return { last, text: clipboard.readText() };
            await new Promise(r => setTimeout(r, 50));
          }
        }
        return { last, text: clipboard.readText() };
      };
      const sharedRow = siteA.rows.find(r => r.username === 'shared@example.com');
      const pw = await clipboardSettles(() => copyCredentialField(sharedRow.id, 'password', 'vercel', 'team-a', 'https://vercel.com/login'), 'shared-pw');
      check('copy-writes-the-right-password-to-the-clipboard',
        pw.last.ok === true && pw.text === 'shared-pw' && !JSON.stringify(pw.last).includes('shared-pw'),
        `ok=${pw.last.ok} label="${pw.last.label}" clipboard-match=${pw.text === 'shared-pw'}`);
      const mail = await clipboardSettles(() => copyCredentialField(sharedRow.id, 'username', 'vercel', 'team-a', 'https://vercel.com/login'), 'shared@example.com');
      check('copy-email-writes-the-username', mail.last.ok === true && mail.text === 'shared@example.com',
        `label="${mail.last.label}" clipboard-match=${mail.text === 'shared@example.com'}`);
      const badField = copyCredentialField(sharedRow.id, 'reveal', 'vercel', 'team-a', 'https://vercel.com/login');
      check('copy-refuses-an-unknown-field', badField.ok === false && badField.reason === 'bad-field', `reason=${badField.reason}`);
      clipboard.clear();
      // the chip counts exactly the rows the picker would list (main computes both)
      check('site-list-count-matches-the-rows',
        siteLoginRows('vercel', 'team-a', 'https://vercel.com/login').rows.length === 3
          && siteLoginRows('vercel', 'team-c', 'https://example.com/').rows.length === 0,
        `team-a=${siteLoginRows('vercel', 'team-a', 'https://vercel.com/login').rows.length}`);
      // Use from the picker is the SAME 0.9.0 path: fill-login(key, id) sets the default, then fills.
      // Main-side we can prove the default half; the fill half is the existing Use contract.
      const pickRow = siteA.rows.find(r => r.username === 'carol@example.com');
      useAsDefault('vercel', 'team-a', pickRow.id);
      check('use-from-picker-sets-the-account-default',
        siteLoginRows('vercel', 'team-a', 'https://vercel.com/login').rows.find(r => r.id === pickRow.id).isDefault === true
          && siteLoginRows('vercel', 'team-b', 'https://vercel.com/login').rows.find(r => r.id === pickRow.id).isDefault === false,
        managerRows().find(r => r.id === pickRow.id).defaultForAccounts.join() || 'none');
      setOrClearDefault(null, 'vercel', 'team-a', 'https://vercel.com/login');
    } finally { try { fs.rmSync(csv3, { force: true }); } catch {} }

    const st = creds.stats();
    check('stats', st.total >= 3, JSON.stringify(st.bySource));
    const browsers = creds.listChromiumProfiles();
    console.log(`[smoke:creds] INFO detected browser profiles: ${browsers.map(b => `${b.browser}/${b.profile}`).join(', ') || 'none'}`);
    creds.clearAll();
    check('clear', creds.stats().total === 0);
  } catch (err) {
    check('exception', false, err.message);
  } finally {
    try { fs.rmSync(csv, { force: true }); } catch {}
  }
  fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(results, null, 2));
  app.exit(results.checks.every(c => c.ok) ? 0 : 1);
}

// ---------- smoke autofill: real page, real preload — fill AND capture ----------
async function runSmokeAutofill() {
  const results = { mode: 'autofill', checks: [] };
  const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`[smoke:autofill] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const page = path.join(app.getPath('temp'), `mam-login-${process.pid}.html`);
  fs.writeFileSync(page, `<!doctype html><meta charset=utf-8><title>Login</title>
    <form id=f><input name=email type=email><input name=pw type=password><button type=submit>Sign in</button></form>`);

  const win = new BaseWindow({ width: 900, height: 700, show: false });
  const vm = new ViewManager();
  vm.attach(win);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- origin guard regression checks (the review found both of these as critical) ----
  check('origin-guard-accepts-service-host', originAllowed('vercel', 'https://vercel.com/login'));
  check('origin-guard-accepts-subdomain', originAllowed('supabase', 'https://api.supabase.com/x'));
  check('origin-guard-rejects-foreign-host', !originAllowed('vercel', 'https://accounts.google.com/signin'));
  check('origin-guard-rejects-lookalike', !originAllowed('vercel', 'https://vercel.com.evil.example/login'));
  creds.rememberForAccount('vercel', 'guardtest', { url: 'https://vercel.com/login', username: 'v@example.com', password: 'vercel-pw' });
  const crossOrigin = creds.forAccount('vercel', 'guardtest', 'https://accounts.google.com/signin');
  check('credential-not-returned-for-foreign-origin', !crossOrigin || crossOrigin.host !== 'vercel.com',
    crossOrigin ? `leaked ${crossOrigin.host}` : 'none');
  const sameOrigin = creds.forAccount('vercel', 'guardtest', 'https://vercel.com/login');
  check('credential-returned-for-own-origin', !!sameOrigin && sameOrigin.password === 'vercel-pw');

  // capture: the preload must report credentials typed into a real form
  let captured = null;
  ipcMain.on('credential-captured', (_e, d) => { captured = d; });
  let formSeen = false;
  ipcMain.on('login-form-present', (_e, i) => { if (i && i.present) formSeen = true; });

  vm.create('vercel', 'autofilltest', `file:///${page.replace(/\\/g, '/')}`, { show: false });
  const tab = vm.tabs.get(accountKey('vercel', 'autofilltest'));
  await new Promise(r => tab.view.webContents.once('did-finish-load', r));
  await sleep(1500);
  check('preload-detected-login-form', formSeen);

  // fill: main pushes a stored credential into the page
  creds.rememberForAccount('vercel', 'autofilltest', { url: 'https://vercel.com/login', username: 'me@example.com', password: 'p@ss-fill' });
  const cred = creds.forAccount('vercel', 'autofilltest', 'https://vercel.com/login');
  // 0.9.0: the answer is correlated by requestId, and main now WAITS for it — a fill is only
  // reported as done when the page really took the values.
  const fills = [];
  ipcMain.on('fill-result', (_e, r) => fills.push(r));
  const requestId = 'smoke-fill-1';
  tab.view.webContents.send('fill-credential', { requestId, username: cred.username, password: cred.password, submit: false });
  await sleep(800);
  const filled = await tab.view.webContents.executeJavaScript(
    `({ email: document.querySelector('[name=email]').value, pw: document.querySelector('[name=pw]').value })`);
  check('fill-username', filled.email === 'me@example.com', filled.email);
  check('fill-password', filled.pw === 'p@ss-fill', filled.pw ? '(set)' : '(empty)');
  check('fill-result-carries-request-id', fills.some(r => r.requestId === requestId && r.ok === true && r.user === true && r.password === true),
    JSON.stringify(fills[fills.length - 1] || null));

  // undo: clear exactly what the fill put in, and nothing else (the user's own typing survives)
  await tab.view.webContents.executeJavaScript(`document.querySelector('[name=email]').value = 'me@example.com'`);
  const undoId = 'smoke-undo-1';
  tab.view.webContents.send('clear-filled', { requestId: undoId, fillId: requestId });
  await sleep(600);
  const afterUndo = await tab.view.webContents.executeJavaScript(
    `({ email: document.querySelector('[name=email]').value, pw: document.querySelector('[name=pw]').value })`);
  check('undo-clears-filled-fields', afterUndo.pw === '' && afterUndo.email === '', JSON.stringify(afterUndo));
  check('undo-reports-what-it-cleared', fills.some(r => r.requestId === undoId && r.ok === true && r.cleared >= 1),
    JSON.stringify(fills[fills.length - 1] || null));
  // a second undo of the same fill must be refused: the field references are gone, not "still filled"
  const undoAgain = 'smoke-undo-2';
  tab.view.webContents.send('clear-filled', { requestId: undoAgain, fillId: requestId });
  await sleep(400);
  check('undo-twice-is-refused', fills.some(r => r.requestId === undoAgain && r.ok === false && r.reason === 'nothing-filled'));
  // an undo naming a DIFFERENT fill must not clear this document's fields either
  const undoWrong = 'smoke-undo-3';
  tab.view.webContents.send('fill-credential', { requestId: 'smoke-fill-2', username: cred.username, password: cred.password, submit: false });
  await sleep(500);
  tab.view.webContents.send('clear-filled', { requestId: undoWrong, fillId: 'some-other-fill' });
  await sleep(400);
  const stillFilled = await tab.view.webContents.executeJavaScript(`document.querySelector('[name=pw]').value`);
  check('undo-refuses-a-stale-fill-id', stillFilled === 'p@ss-fill' && fills.some(r => r.requestId === undoWrong && r.ok === false),
    stillFilled ? '(untouched)' : '(cleared — wrong)');

  // capture: submitting the form must hand the credentials back to main
  await tab.view.webContents.executeJavaScript(`(() => {
    const f = document.getElementById('f');
    document.querySelector('[name=email]').value = 'typed@example.com';
    document.querySelector('[name=pw]').value = 'typed-secret';
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(800);
  check('capture-on-submit', !!captured && captured.username === 'typed@example.com' && captured.password === 'typed-secret',
    captured ? captured.username : 'nothing captured');

  creds.clearAll();
  try { fs.rmSync(page, { force: true }); } catch {}
  fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(results, null, 2));
  app.exit(results.checks.every(c => c.ok) ? 0 : 1);
}

// ---------- smoke updates: version comparison + real release-feed check ----------
async function runSmokeUpdates() {
  const results = { mode: 'updates', checks: [] };
  const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`[smoke:updates] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

  check('newer-detects-patch', updater.isNewer('0.2.1', '0.2.2'));
  check('newer-detects-minor', updater.isNewer('0.2.9', '0.3.0'));
  check('newer-handles-double-digits', updater.isNewer('0.2.9', '0.2.10'));
  check('not-newer-when-same', !updater.isNewer('0.2.2', '0.2.2'));
  check('not-newer-when-older', !updater.isNewer('0.3.0', '0.2.9'));

  const init = updater.init(() => {});
  check('reports-current-version', init.currentVersion === app.getVersion(), init.currentVersion);
  check('knows-it-cannot-install-in-dev', init.canDownload === false && init.packaged === false);
  check('update-installs-silently-and-relaunches', updater.INSTALL_MODE.isSilent === true && updater.INSTALL_MODE.isForceRunAfter === true);
  check('auto-update-defaults-on', store.settings.autoUpdate === true && init.autoUpdate === true);
  check('auto-update-toggle', updater.setAutoUpdate(false) === false && updater.snapshot().autoUpdate === false && updater.setAutoUpdate(true) === true);

  const s = await updater.check();
  check('check-completes-with-a-verdict', ['available', 'up-to-date', 'error'].includes(s.status), `status=${s.status}`);
  console.log(`[smoke:updates] INFO latest=${s.latestVersion || 'n/a'} error=${s.error || 'none'}`);
  // A private repo returns 404 unauthenticated — the message must say so rather than being cryptic.
  if (s.status === 'error') check('error-is-actionable', /private|release|network|token/i.test(s.error || ''), s.error);

  fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(results, null, 2));
  app.exit(results.checks.every(c => c.ok) ? 0 : 1);
}

// ---------- smoke dark: Dark Reader's API build really darkens, and only inside the isolated world ----------
// The old check asserted a Dark Reader extension was LOADED, which was vacuous: its MV3 worker
// crashed on Electron 43 and only the OS-preference fallback CSS ever ran. This one asserts the
// engine actually changes computed colours AND that the page's own main world is left untouched
// (invariant 2), which is the whole reason the engine is not shipped as a browser extension.
async function runSmokeDark() {
  const results = { mode: 'dark', checks: [] };
  const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`[smoke:dark] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const win = new BaseWindow({ width: 900, height: 700, show: false });
  const vm = new ViewManager();
  vm.attach(win);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // The vendored bundle must be the exact self-contained build the app ships.
  const vroot = path.join(__dirname, '..', 'vendor', 'darkreader');
  let bytes = 0; let version = '';
  try { bytes = fs.statSync(path.join(vroot, 'darkreader.js')).size; } catch {}
  try { version = JSON.parse(fs.readFileSync(path.join(vroot, 'package.json'), 'utf8')).version || ''; } catch {}
  check('vendored-bundle-present', bytes > 300000, `${bytes} bytes`);
  check('vendored-version', version === '4.9.133', version || 'unreadable');
  check('vendored-license-mit', (() => { try { return /MIT License/.test(fs.readFileSync(path.join(vroot, 'LICENSE'), 'utf8')); } catch { return false; } })());

  // A local page whose background is explicitly WHITE. Its baseline colour is known, so "it got
  // dark" can never be vacuous (a real dashboard that already honours prefers-color-scheme would).
  // Served over file://, so this check needs no network.
  const html = '<!doctype html><html><head><style>html,body{background:#ffffff;color:#111111}</style></head><body><h1>probe</h1></body></html>';
  const p1 = path.join(app.getPath('temp'), 'mam-dark-white.html');
  const p2 = path.join(app.getPath('temp'), 'mam-dark-white2.html');
  fs.writeFileSync(p1, html); fs.writeFileSync(p2, html);
  const toUrl = p => require('url').pathToFileURL(p).href;

  store.settings.darkMode = true; // the create path injects only when this is on
  vm.create('vercel', 'darkprobe', toUrl(p1), { show: false });
  const probe = vm.tabs.get(accountKey('vercel', 'darkprobe'));
  const wc = probe.view.webContents;
  const bgOf = async () => {
    try { return await wc.executeJavaScript(`getComputedStyle(document.documentElement).backgroundColor`); } catch { return ''; }
  };
  const inWorld = async code => {
    try { return await wc.executeJavaScriptInIsolatedWorld(dark.DARK_WORLD_ID, [{ code }]); } catch { return undefined; }
  };
  await new Promise(r => wc.once('did-finish-load', r));
  await sleep(3000); // let the engine compute and apply

  const bgOn = await bgOf();
  check('page-darkens-with-dark-reader', !!bgOn && bgOn !== '' && !/255,\s*255,\s*255/.test(bgOn), bgOn);

  // Invariant 2: the page's own main world must be untouched while darkening is active.
  const mainGlobal = await wc.executeJavaScript(`typeof window.DarkReader`).catch(() => '');
  check('main-world-has-no-darkreader-global', mainGlobal === 'undefined', `typeof window.DarkReader = ${mainGlobal}`);
  const sheetsGetter = await wc.executeJavaScript(`String(Object.getOwnPropertyDescriptor(Document.prototype,'styleSheets').get)`).catch(() => '');
  check('main-world-stylesheets-getter-native', /native code/.test(sheetsGetter), sheetsGetter.slice(0, 40));
  // The engine itself lives in the isolated world — exactly where it is supposed to be.
  const worldType = await inWorld('typeof window.DarkReader');
  check('engine-runs-in-isolated-world', worldType === 'object', `isolated world typeof = ${worldType}`);

  // Toggling OFF restores the page's own colours, in place (no reload).
  await dark.disable(wc);
  await sleep(1500);
  const bgOff = await bgOf();
  check('disable-restores-native-colours', /255,\s*255,\s*255/.test(bgOff), `off=${bgOff}`);

  // A cross-origin navigation discards the isolated world and the Dark Reader inside it; the
  // did-navigate hook must re-inject and re-darken. A second local file is a different origin.
  await new Promise(r => { wc.once('did-finish-load', r); wc.loadURL(toUrl(p2)).catch(() => {}); });
  await sleep(3000);
  const bgNav = await bgOf();
  check('re-darkens-after-cross-origin-navigation', !!bgNav && !/255,\s*255,\s*255/.test(bgNav), bgNav);

  // ================= 0.11.0: PER-ACCOUNT CONTENT SETTINGS =================
  // The nine checks above are the pre-0.11.0 goldens and stay untouched (no assertion edited). This
  // section is additive: dark overrides (5), ad-block (6 — the first ad-block coverage this suite
  // has ever had), then the data/API contracts (4).
  //
  // Every check runs offline: the dark checks use two local white pages, and the ad-block checks use
  // a seed-listed ad host that CANNOT resolve. With the blocker on the request dies as
  // net::ERR_BLOCKED_BY_CLIENT (-20); with it off the same request dies as net::ERR_NAME_NOT_RESOLVED
  // (-105) — measured on this machine against the repo's real src/content.js before this was written.
  // The two codes are therefore a real, network-free witness of the network-layer decision.
  const isDark = bg => !!bg && bg !== '' && !/255,\s*255,\s*255/.test(bg);
  const isWhite = bg => /255,\s*255,\s*255/.test(bg || '');

  // A fresh account + a fresh white document, loaded through the REAL create path so the real
  // did-finish-load apply (and the real per-request closure in makeView) is what gets measured.
  const mk = async (id, url) => {
    vm.create('vercel', id, url, { show: false });
    const t = vm.tabs.get(accountKey('vercel', id));
    // create() calls loadURL without waiting, so either the load is still in flight or it already
    // finished (a cached file:// page) — never wait for an event that has already fired.
    if (t.view.webContents.isLoading()) await new Promise(r => t.view.webContents.once('did-finish-load', r));
    return t;
  };
  const bgOfTab = async t => {
    try { return await t.view.webContents.executeJavaScript(`getComputedStyle(document.documentElement).backgroundColor`); } catch { return ''; }
  };
  const engineOf = async t => {
    try { return await t.view.webContents.executeJavaScriptInIsolatedWorld(dark.DARK_WORLD_ID, [{ code: 'typeof window.DarkReader' }]); } catch { return undefined; }
  };

  // Reset the registry and the global settings this section depends on, then build a control view
  // with NO overrides at all (the equality baseline every per-account assertion compares against).
  store.accounts = store.accounts.filter(a => a.svc !== 'vercel' || !/^x-/.test(a.id));
  store.settings.darkMode = true; store.settings.adBlock = true;
  const control = await mk('x-control', toUrl(p1));
  await sleep(3200);
  const controlDark = await bgOfTab(control);
  const controlEngine = await engineOf(control);

  // 1. global ON, A override off, B follows -> A white, B dark.
  registerAccount('vercel', 'x-a');
  updateContentOverride(findAccount('vercel', 'x-a'), 'darkMode', 'off');
  const aOff = await mk('x-a', toUrl(p1));
  const bFollowOn = await mk('x-b', toUrl(p1));
  await sleep(3200);
  const aOffBg = await bgOfTab(aOff); const bOnBg = await bgOfTab(bFollowOn);
  check('per-account-dark-override-off-while-global-on', isWhite(aOffBg) && isDark(bOnBg), `A=${aOffBg} B=${bOnBg}`);

  // 2. global OFF, A override on, B follows -> A dark, B white (Q2: true override, both directions).
  store.settings.darkMode = false;
  const cOff = await mk('x-c', toUrl(p1));
  registerAccount('vercel', 'x-d');
  updateContentOverride(findAccount('vercel', 'x-d'), 'darkMode', 'on');
  const dOn = await mk('x-d', toUrl(p1));
  await sleep(3200);
  const cOffBg = await bgOfTab(cOff); const dOnBg = await bgOfTab(dOn);
  check('per-account-dark-override-on-while-global-off', isDark(dOnBg) && isWhite(cOffBg), `C(global-off)=${cOffBg} D(override-on)=${dOnBg}`);

  // 3. follow-global is byte-for-byte the control view: same computed colour AND same engine presence.
  store.settings.darkMode = true;
  const follow = await mk('x-e', toUrl(p1));
  await sleep(3200);
  const followBg = await bgOfTab(follow); const followEngine = await engineOf(follow);
  check('per-account-dark-follow-global',
    followBg === controlDark && followEngine === controlEngine && followEngine === 'object',
    `follow=${followBg}/${followEngine} control=${controlDark}/${controlEngine}`);

  // 4. override change applies to the OPEN document with no reload: the h1 keeps an in-page marker
  //    (a reload would drop it), while the colour returns to white. B (untouched) keeps its colour.
  await follow.view.webContents.executeJavaScript(`document.querySelector('h1').setAttribute('data-marker','kept')`).catch(() => {});
  const bBefore4 = await bgOfTab(bFollowOn);
  setAccountContentOverride(vm, 'vercel', 'x-e', 'darkMode', 'off');
  await sleep(1800);
  const marker = await follow.view.webContents.executeJavaScript(`document.querySelector('h1') && document.querySelector('h1').getAttribute('data-marker')`).catch(() => null);
  const followBg4 = await bgOfTab(follow); const bAfter4 = await bgOfTab(bFollowOn);
  check('per-account-override-change-applies-without-reload',
    followBg4 !== '' && isWhite(followBg4) && marker === 'kept' && bAfter4 === bBefore4,
    `marker=${marker} bg=${followBg4} B before/after=${bBefore4}/${bAfter4}`);

  // 5. an untouched account is unchanged by a sibling's override: compare a following tab with the
  //    control view created before ANY override existed.
  const untouched = await mk('x-f', toUrl(p1));
  await sleep(3200);
  const untouchedBg = await bgOfTab(untouched); const untouchedEngine = await engineOf(untouched);
  check('per-account-dark-untouched-account-unchanged',
    untouchedBg === controlDark && untouchedEngine === controlEngine,
    `untouched=${untouchedBg}/${untouchedEngine} control=${controlDark}/${controlEngine}`);

  // ---------- ad-block: the offline ERR_BLOCKED_BY_CLIENT / ERR_NAME_NOT_RESOLVED discriminator ----------
  // A seed-listed ad host whose SUBDOMAIN cannot resolve. hostBlocked() walks parent domains, so it
  // is blocked by the predicate, while DNS guarantees the "not blocked" answer is a different code.
  const ADHOST = 'mam011-smoke-no-such-host.doubleclick.net';
  const frameCode = async t => {
    const wc = t.view.webContents;
    const got = await new Promise(resolve => {
      const seen = [];
      const onFail = (_e, code, desc, _vurl, isMainFrame) => { if (!isMainFrame) seen.push(desc); };
      wc.on('did-fail-load', onFail);
      wc.executeJavaScript(`(() => { const old = document.getElementById('mam-ad-probe'); if (old) old.remove();
        const f = document.createElement('iframe'); f.id = 'mam-ad-probe';
        f.src = 'https://${ADHOST}/ad.html'; document.body.appendChild(f); return f.src; })()`).catch(() => {});
      setTimeout(() => { wc.removeListener('did-fail-load', onFail); resolve(seen); }, 6000);
    });
    return got[0] || 'none';
  };
  // A fresh document is what makes the check independent of earlier iframes: reload once, then probe.
  const reloadAndProbe = async t => {
    const wc = t.view.webContents;
    await new Promise(r => { wc.once('did-finish-load', r); wc.reload(); });
    await sleep(600);
    return frameCode(t);
  };

  // 6. global ON, A override off, B follows -> A is NOT blocked, B IS blocked.
  store.settings.adBlock = true;
  registerAccount('vercel', 'x-g');
  updateContentOverride(findAccount('vercel', 'x-g'), 'adBlock', 'off');
  const gOff = await mk('x-g', toUrl(p1));
  await sleep(800);
  const gCode = await reloadAndProbe(gOff);
  const bCode = await reloadAndProbe(bFollowOn);
  check('per-account-adblock-override-off-while-global-on',
    gCode === 'ERR_NAME_NOT_RESOLVED' && bCode === 'ERR_BLOCKED_BY_CLIENT', `G(override-off)=${gCode} B(follow)=${bCode}`);

  // 7. global OFF, D override on (D already exists with a dark override), E follows -> D blocked, C not.
  store.settings.adBlock = false;
  updateContentOverride(findAccount('vercel', 'x-d'), 'adBlock', 'on');
  const dCode = await reloadAndProbe(dOn);
  const cCode2 = await reloadAndProbe(cOff);
  check('per-account-adblock-override-on-while-global-off',
    dCode === 'ERR_BLOCKED_BY_CLIENT' && cCode2 === 'ERR_NAME_NOT_RESOLVED', `D(override-on)=${dCode} C(global-off)=${cCode2}`);

  // 8. follow-global: an un-overridden account produces exactly the code the global dictates. With
  //    the global back on, that is BLOCKED — the same answer the control view would give.
  store.settings.adBlock = true;
  const fCode = await reloadAndProbe(follow); // x-e has only a darkMode override: adBlock follows
  check('per-account-adblock-follow-global', fCode === 'ERR_BLOCKED_BY_CLIENT', `E(follow, global on)=${fCode}`);

  // 9. a LIVE flip changes the next request's outcome with no reload: x-g is overridden off; clearing
  //    the override (it follows the on global) blocks the SAME host, in the SAME document. A page
  //    marker proves the document survived — a URL comparison alone would NOT, because a reload keeps
  //    the URL (mutation 4 caught exactly that: it reloaded on the on-flip and still passed).
  await gOff.view.webContents.executeJavaScript(`window.__mamFlipMark = 'alive'`).catch(() => {});
  const urlBefore9 = gOff.view.webContents.getURL();
  setAccountContentOverride(vm, 'vercel', 'x-g', 'adBlock', 'follow');
  await sleep(400);
  const gCodeLive = await frameCode(gOff);
  const urlAfter9 = gOff.view.webContents.getURL();
  const flipMark = await gOff.view.webContents.executeJavaScript(`window.__mamFlipMark || 'gone'`).catch(() => 'gone');
  check('adblock-live-flip-no-reload',
    gCodeLive === 'ERR_BLOCKED_BY_CLIENT' && urlBefore9 === urlAfter9 && flipMark === 'alive',
    `after=${gCodeLive} url ${urlBefore9 === urlAfter9 ? 'unchanged' : 'CHANGED'} document=${flipMark}`);

  // 10. cosmetic per account: applyToPage hides the ad slot for an on-account and leaves it for an
  //     off-account. The seed list carries no generic cosmetics (they come from a fetched EasyList),
  //     so the check installs ONE known selector into the live filter set for the duration of the
  //     assertion and restores it in a finally — the module's bytes are untouched (it is frozen), and
  //     the check then measures the real did-finish-load apply for two accounts that resolve
  //     differently. `display:none` vs `display:block` is the observable.
  const cosFile = path.join(app.getPath('temp'), 'mam-content-cosmetic.html');
  fs.writeFileSync(cosFile, '<!doctype html><html><head><style>#ad-slot{display:block;height:10px;width:10px}</style></head><body><div id="ad-slot"></div><h1>probe</h1></body></html>');
  const savedCosmetic = content.filters.cosmetic;
  content.filters.cosmetic = ['#ad-slot'];
  let cosOn = ''; let cosOff = ''; let cosOffTab = null;
  try {
    const onT = await mk('x-h', toUrl(cosFile));
    await sleep(900);
    cosOn = await onT.view.webContents.executeJavaScript(`getComputedStyle(document.getElementById('ad-slot')).display`).catch(() => '');
    registerAccount('vercel', 'x-i');
    updateContentOverride(findAccount('vercel', 'x-i'), 'adBlock', 'off');
    const offT = await mk('x-i', toUrl(cosFile));
    await sleep(900);
    cosOff = await offT.view.webContents.executeJavaScript(`getComputedStyle(document.getElementById('ad-slot')).display`).catch(() => '');
    cosOffTab = offT; // used by check 11 below
  } finally { content.filters.cosmetic = savedCosmetic; }
  check('adblock-cosmetic-per-account', cosOn === 'none' && cosOff === 'block',
    `following(adBlock on)=${cosOn} overridden-off=${cosOff}`);

  // 11. a reload caused by ANOTHER account's ad-block change never reaches this account's document.
  //     Toggling the GLOBAL off and back on makes every FOLLOWING account's resolved value move
  //     (off, then on: the "on" half re-applies cosmetics, the "off" half reloads), while x-i is
  //     overridden off and resolves `false` at both points — so it must not reload. A page-global
  //     marker survives a non-reload and dies on a reload.
  const offTab = cosOffTab;
  await gOff.view.webContents.executeJavaScript(`window.__mamMark = 'alive'`).catch(() => {});
  await offTab.view.webContents.executeJavaScript(`window.__mamMark = 'alive'`).catch(() => {});
  setGlobalContentSetting(vm, 'adBlock', false);
  await sleep(500);
  setGlobalContentSetting(vm, 'adBlock', true);
  await sleep(2000);
  const gMark = await gOff.view.webContents.executeJavaScript(`window.__mamMark || 'gone'`).catch(() => 'gone');
  const iMark = await offTab.view.webContents.executeJavaScript(`window.__mamMark || 'gone'`).catch(() => 'gone');
  check('adblock-off-account-unaffected-by-other-accounts-reload', gMark === 'gone' && iMark === 'alive',
    `following(${gMark}) overridden-off(${iMark})`);

  // ---------- data / API contracts ----------
  // 12. sparse storage: setting one key never creates the other, and clearing deletes the key.
  registerAccount('vercel', 'x-j');
  setAccountContentOverride(vm, 'vercel', 'x-j', 'adBlock', 'off');
  const jAcc = findAccount('vercel', 'x-j');
  check('content-override-stored-sparse',
    JSON.stringify(jAcc.contentOverride) === JSON.stringify({ adBlock: 'off' }),
    JSON.stringify(jAcc.contentOverride));

  // 13. the owner's bar, mechanically: set then clear leaves accounts.json byte-identical.
  const accFile = path.join(app.getPath('userData'), 'accounts.json');
  registerAccount('vercel', 'x-k');
  const before13 = fs.readFileSync(accFile);
  setAccountContentOverride(vm, 'vercel', 'x-k', 'darkMode', 'on');
  setAccountContentOverride(vm, 'vercel', 'x-k', 'darkMode', 'follow');
  const after13 = fs.readFileSync(accFile);
  check('content-override-clear-is-byte-identical', before13.equals(after13),
    `${before13.length} vs ${after13.length} bytes; key present after clear: ${'contentOverride' in findAccount('vercel', 'x-k')}`);

  // 14. the IPC rejects an unknown name and an unknown account (mirrors account-no-autofill).
  const throws = fn => { try { fn(); return false; } catch { return true; } };
  check('content-override-rejects-unknown-name', throws(() => setAccountContentOverride(vm, 'vercel', 'x-j', 'network', 'on')));
  check('content-override-rejects-unknown-account', throws(() => setAccountContentOverride(vm, 'vercel', 'nobody', 'adBlock', 'on')));
  // 15. only on / off / follow are accepted — and nothing is written when the value is refused.
  const jBefore = JSON.stringify(findAccount('vercel', 'x-j').contentOverride);
  check('content-override-invalid-value-rejected',
    throws(() => setAccountContentOverride(vm, 'vercel', 'x-j', 'adBlock', 'yes'))
      && JSON.stringify(findAccount('vercel', 'x-j').contentOverride) === jBefore,
    `stored=${jBefore}`);

  // ---------- the resolver contract (MUTATION-PLUS) ----------
  // The follow path must be derived from the GLOBAL, never a hardcoded literal. The spec's own
  // formula is `!!settings[name]`, so the returned value is the global's truthiness — not the raw
  // value (a string fake therefore reads `true`, and asserting raw identity would be asserting
  // against the contract). What a literal default cannot do is FOLLOW the global in both directions:
  // a resolver hardcoded to true fails the first half, one hardcoded to false fails the second.
  const followOn = resolveContent({}, 'adBlock', { adBlock: true });
  const followOff = resolveContent({ contentOverride: {} }, 'adBlock', { adBlock: false });
  const followUnset = resolveContent({}, 'darkMode', {});
  const followOverridden = resolveContent({ contentOverride: { adBlock: 'on' } }, 'adBlock', { adBlock: false });
  check('resolver-follow-tracks-the-global-not-a-literal',
    followOn === true && followOff === false && followUnset === false && followOverridden === true,
    `global true->${followOn}, global false->${followOff}, unset->${followUnset}, override-on-over-global-off->${followOverridden}`);

  fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(results, null, 2));
  app.exit(results.checks.every(c => c.ok) ? 0 : 1);
}

// ---------- smoke restore: app restart, verify partitions persisted ----------
async function runSmokeRestore() {
  const win = new BaseWindow({ width: 1280, height: 800, show: false });
  const vm = new ViewManager();
  vm.attach(win);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const results = { mode: 'restore', checks: [] };
  const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`[smoke:restore] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

  const pre = ['netlify', 'supabase', 'vercel'].map(s => partitionDir(s, 'a1'));
  const preExisting = pre.filter(p => fs.existsSync(p));
  check('partitions-exist-before-open', preExisting.length === 3, `${preExisting.length}/3`);

  // reopen the same accounts; if cookies persisted, the login pages should still carry session cookies
  vm.create('netlify', 'a1', SERVICES.find(s => s.key === 'netlify').dashboardUrl, { show: false });
  vm.create('supabase', 'a1', SERVICES.find(s => s.key === 'supabase').dashboardUrl, { show: false });
  vm.create('vercel', 'a1', SERVICES.find(s => s.key === 'vercel').dashboardUrl, { show: false });
  await sleep(12000);

  const cookieCounts = [];
  for (const [svc] of [['netlify'], ['supabase'], ['vercel']]) {
    const ses = session.fromPartition(partitionFor(svc, 'a1'));
    const cookies = await ses.cookies.get({});
    cookieCounts.push({ svc, count: cookies.length });
  }
  check('cookies-persisted-across-restart', cookieCounts.every(c => c.count > 0), JSON.stringify(cookieCounts));

  fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(results, null, 2));
  app.exit(results.checks.every(c => c.ok) ? 0 : 1);
}

// ---------- demo seed: placeholder accounts + logins for screenshots ----------
// ONLY for capture runs against a scratch profile (MAM_USER_DATA). The names are invented; no real
// account name or password is ever used or written (CLAUDE.md §5). Idempotent, so a capture can be
// re-run against the same scratch dir.
function seedDemoLogins() {
  const placements = [
    ['vercel', 'work', 'demo.user.one@example.com'],
    ['vercel', 'personal', 'demo.user.two@example.com'],
    ['netlify', 'agency', 'demo.user.three@example.com'],
    ['supabase', 'staging', 'demo.user.four@example.com'],
    ['github', 'open-source', 'demo.user.five@example.com'],
    ['cloudflare', 'domains', 'demo.user.six@example.com'],
    ['railway', 'side-project', 'demo.user.seven@example.com'],
    ['stripe', 'payments', 'demo.user.eight@example.com'],
  ];
  for (const [svc, id, label] of placements) registerAccount(svc, id, label);
  // Seed the logins as well: on this machine safeStorage can encrypt in one process but not decrypt
  // what another process wrote (proved with a bare two-process round trip that never touches this
  // app, 2026-11-03), so a capture that only reads a previously seeded file would show 0 rows. The
  // seed runs FIRST, in the same process as the capture, so the screenshots show the real managers
  // with their real rows. Nothing outside the scratch profile is touched.
  // Imported-style logins (no accountKey) — the "all my logins imported" case the owner reported.
  // Written through the REAL CSV importer (the only import entry point credentials.js exports), so
  // this exercises the same merge rules a user's import does. Placeholder passwords only.
  const imports = [
    ['vercel.com', 'demo.user.one@example.com'],
    ['vercel.com', 'demo.user.two@example.com'],
    ['app.netlify.com', 'demo.user.three@example.com'],
    ['supabase.com', 'demo.user.four@example.com'],
    ['github.com', 'demo.user.five@example.com'],
    ['dash.cloudflare.com', 'demo.user.six@example.com'],
    ['railway.com', 'demo.user.seven@example.com'],
    ['dashboard.stripe.com', 'demo.user.eight@example.com'],
  ];
  const csv = path.join(app.getPath('temp'), `mam-demo-${process.pid}.csv`);
  fs.writeFileSync(csv, 'url,username,password\n' + imports.map(([h, u]) => `https://${h}/login,${u},demo-placeholder-${u.length}\n`).join(''));
  try { creds.importFromCsv(csv); } finally { try { fs.rmSync(csv, { force: true }); } catch {} }
  // every account keeps its OWN captured login (so "saved for this account" is exercised too)
  for (const [svc, id, who] of [['vercel', 'work', 'demo.user.one@example.com'], ['github', 'open-source', 'demo.user.five@example.com']]) {
    creds.rememberForAccount(svc, id, { url: serviceByKey(svc).loginUrl, username: who, password: `demo-placeholder-${who.length}` });
  }
  const rows = creds.listCredentials();
  // one ★ so the manager shows the "Default for …" line, the way a real profile would
  const first = rows.find(c => c.host === 'vercel.com' && c.username === 'demo.user.two@example.com');
  if (first) creds.setDefaultForAccount(first.id, 'vercel', 'personal', 'https://vercel.com/login');
  console.log(`[demo] seeded ${store.accounts.length} accounts, ${creds.stats().total} logins`);
}

// ---------- interactive mode ----------
function runInteractive(captureMode = false) {
  // BrowserWindow, not BaseWindow: the chrome page needs loadFile/webContents/ready-to-show, which
  // BaseWindow lacks entirely. BrowserWindow extends BaseWindow, so contentView.addChildView (account
  // views), getContentSize, and Menu accelerators all keep working.
  const win = new BrowserWindow({
    width: 1400, height: 900,
    backgroundColor: '#1b1d22',
    show: captureMode, // capturePage fails on hidden windows — capture mode must SHOW the window
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  const vm = new ViewManager();
  vm.attach(win);
  reloadPlugins(); // Phase 3: service manifests from <userData>/plugins
  content.loadFilters().then(src => console.log(`[adblock] filters from ${src}: ${content.filters.hosts.size} hosts, ${content.filters.cosmetic.length} cosmetic`));
  win.loadFile(path.join(__dirname, 'ui.html'));
  // Update system: version tracking + release info + explicit user-driven download/install.
  // Nothing downloads or installs on its own; the UI shows what is available and you decide.
  updater.init(s => { if (win && win.webContents && !win.webContents.isDestroyed()) win.webContents.send('update-state', s); }, { autoUpdate: store.settings.autoUpdate !== false });
  updater.check().catch(() => {});                                 // one check at startup
  setInterval(() => updater.check().catch(() => {}), 60 * 60 * 1000); // and hourly after that
  const applyBounds = () => {
    const [w, h] = win.getContentSize();
    // reserve the left rail: account views start after it, so the rail (and Home) is always reachable
    vm.setBounds({ x: RAIL_W, y: TAB_STRIP_H, width: Math.max(0, w - RAIL_W), height: h - TAB_STRIP_H });
  };
  win.once('ready-to-show', () => { applyBounds(); if (!captureMode) win.show(); });
  if (captureMode) {
    // Screenshot options (used to produce the README images):
    //   --capture-out <file>     where to write the PNG (default ui-screenshot.png)
    //   --capture-open <svc::id> open this account tab before shooting
    //   --capture-scroll <px>    scroll the Home grid down first
    //   --capture-wait <ms>      extra settle time
    //   --capture-js "<expr>"    run an expression in the chrome page (e.g. open a modal)
    // Both "--flag value" and "--flag=value" are accepted. The "=" form matters on this machine:
    // an account key contains "::" and the Git Bash/MSYS layer mangles that in a separate argv
    // token (the process exits 127 before it starts), while "--capture-open=vercel::work" passes
    // through intact. Same value, same code path.
    const argVal = name => {
      const viaEq = process.argv.find(a => a.startsWith(`${name}=`));
      if (viaEq) return viaEq.slice(name.length + 1);
      const i = process.argv.indexOf(name);
      return i > -1 ? process.argv[i + 1] : null;
    };
    const outFile = argVal('--capture-out') || 'ui-screenshot.png';
    const openKey = argVal('--capture-open');
    const scrollPx = Number(argVal('--capture-scroll') || 0);
    const extraWait = Number(argVal('--capture-wait') || 0);
    const runJs = argVal('--capture-js');
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${path.basename(String(sourceId))}:${line})`);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (openKey) {
          const [svc, id] = openKey.split('::');
          vm.create(svc, id, (serviceByKey(svc) || {}).dashboardUrl);
          await new Promise(r => setTimeout(r, Number(argVal('--capture-open-wait') || 20000))); // let the real dashboard paint
        }
        if (scrollPx) await win.webContents.executeJavaScript(`document.getElementById('home').scrollTop = ${scrollPx}`).catch(() => {});
        if (runJs) await win.webContents.executeJavaScript(runJs).catch(err => console.error('[capture] js failed:', err.message));
        // --demo-notice: drive the auto-fill banner exactly the way main does (through
        // autoFillPlan + vm.setNotice), so a screenshot shows the real banner path and not
        // hand-written DOM. Verification aid for a scratch demo profile.
        if (process.argv.includes('--demo-notice') && openKey) {
          const [svc, id] = openKey.split('::');
          const plan = autoFillPlan(svc, id, serviceByKey(svc).loginUrl, { account: findAccount(svc, id) });
          // On a demo profile the logins may be unreadable (DPAPI is per-launch here), so the
          // screenshot's banner uses the same shapes the real paths raise, with placeholder text.
          vm.setNotice(openKey, plan.kind === 'fill'
            ? { kind: 'filled', username: plan.username, credentialId: plan.credentialId, fillId: 'demo' }
            : plan.kind === 'choose' ? { kind: 'choose', choices: plan.choices }
              : { kind: 'filled', username: 'demo.user.two@example.com', credentialId: 'demo-cred', fillId: 'demo' });
          console.log('[capture] demo notice:', plan.kind, (plan.choices || []).length);
          await new Promise(r => setTimeout(r, 700));
        }
        // --demo-home-marker: give two demo accounts one override each through the REAL path, so the
        // Home grid shows the "content: custom" marker the way a user would see it (0.11.0).
        if (process.argv.includes('--demo-home-marker')) {
          try {
            if (findAccount('vercel', 'work')) setAccountContentOverride(vm, 'vercel', 'work', 'darkMode', 'off');
            if (findAccount('netlify', 'agency')) setAccountContentOverride(vm, 'netlify', 'agency', 'adBlock', 'on');
          } catch (err) { console.error('[demo] home marker failed:', err.message); }
          vm.emitState();
          await new Promise(r => setTimeout(r, 800));
          const info = await win.webContents.executeJavaScript(`JSON.stringify([...document.querySelectorAll('.card .contentcustom')].map(m => {
            const r = m.getBoundingClientRect();
            return m.closest('.card').querySelector('.label').innerText + ' :: ' + m.innerText + ' @' + Math.round(r.x) + ',' + Math.round(r.y);
          }))`).catch(err => 'probe failed: ' + err.message);
          console.log('[capture] home markers:', info);
          await new Promise(r => setTimeout(r, 300));
        }
        // --demo-content: give the account in --capture-open one override through the REAL path, then
        // open its gear window from the RENDERER, so the screenshot shows the real three-way selects,
        // the worded resolved state and the honest note (0.11.0). Drives state from main, never from
        // --capture-js (which intermittently exits 127 on this machine). Scratch demo profile only.
        if (process.argv.includes('--demo-content') && openKey) {
          const [dsvc, did] = openKey.split('::');
          try { setAccountContentOverride(vm, dsvc, did, 'darkMode', 'off'); } catch (err) { console.error('[demo] content override failed:', err.message); }
          vm.emitState();
          await new Promise(r => setTimeout(r, 500));
          if (win.webContents && !win.webContents.isDestroyed()) {
            await win.webContents.executeJavaScript(`document.querySelector('[data-gear="${openKey}"]') && document.querySelector('[data-gear="${openKey}"]').click()`).catch(err => console.error('[demo] gear click failed:', err.message));
          }
          await new Promise(r => setTimeout(r, 900));
          const info = await win.webContents.executeJavaScript(`JSON.stringify({
            modalOpen: !document.getElementById('modal-back').hidden,
            selects: [...document.querySelectorAll('#modal select')].map(s => ({ id: s.id, value: s.value, options: s.options.length })),
            states: [...document.querySelectorAll('#modal .contentctl .note')].map(n => n.textContent.trim()),
            note: (() => { const ns = [...document.querySelectorAll('#modal .note')]; const n = ns.find(x => /both directions/.test(x.textContent)); return n ? n.textContent.trim().slice(0, 120) : ''; })(),
          })`).catch(err => 'probe failed: ' + err.message);
          console.log('[capture] demo content:', info);
          // drive one select through the REAL renderer → preload → main chain and read the store back
          const realPath = await win.webContents.executeJavaScript(`(async () => {
            const sel = document.getElementById('m-content-adBlock');
            const before = sel.value;
            sel.value = 'off'; sel.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 900));
            return JSON.stringify({ before, after: sel.value, stateLine: document.getElementById('m-content-adBlock-state').textContent.trim() });
          })()`).catch(err => 'real-path probe failed: ' + err.message);
          console.log('[capture] demo content real path:', realPath, 'stored:', JSON.stringify((findAccount(openKey.split('::')[0], openKey.split('::')[1]) || {}).contentOverride));
          // scroll the modal to its end so the honest note under the selects is in frame
          await win.webContents.executeJavaScript(`(() => { const m = document.getElementById('modal'); if (m) m.scrollTop = m.scrollHeight; return m ? m.scrollTop : -1; })()`).catch(() => {});
          await new Promise(r => setTimeout(r, 400));
        }
        // --demo-picker: open the address-strip key chip's picker from MAIN (state → emitState → the
        // renderer's own click handler), so a screenshot shows the real popover and not hand-written
        // DOM. The chip is drawn from state.siteLogins, so one emitState is enough. Verification aid
        // for a scratch demo profile, like --demo-notice (0.9.0); it changes no shipped behaviour.
        if (process.argv.includes('--demo-picker') && openKey) {
          const key = openKey;
          if (vm.tabs.has(key)) vm.activate(key); // the chip only exists for the ACTIVE tab
          await new Promise(r => setTimeout(r, 800));
          vm.emitState();
          await new Promise(r => setTimeout(r, 600));
          if (win.webContents && !win.webContents.isDestroyed()) {
            await win.webContents.executeJavaScript('document.getElementById("keysite").click()').catch(err => console.error('[capture] picker click failed:', err.message));
          }
          const info = await win.webContents.executeJavaScript(`JSON.stringify({
            chip: document.getElementById('keysite').hidden ? 'hidden' : document.getElementById('keysite').innerText.trim(),
            open: !document.getElementById('keypicker').hidden,
            rows: document.querySelectorAll('#keypicker [data-kp-id]').length,
            search: !!document.getElementById('kp-q'),
            rowsMeta: [...document.querySelectorAll('#keypicker .kp-meta')].map(m => m.innerText.trim()).slice(0, 4),
          })`).catch(err => 'probe failed: ' + err.message);
          console.log('[capture] demo picker:', info);
          // --demo-picker-copied: type in the search box and press Copy password through the real
          // renderer → preload → main chain, then read the clipboard back from MAIN (the secret must
          // never appear in the renderer). Photographs the searched + "Copied ✓" state.
          if (process.argv.includes('--demo-picker-copied') && win.webContents && !win.webContents.isDestroyed()) {
            const wired = await win.webContents.executeJavaScript(`(async () => {
              const q = document.getElementById('kp-q');
              q.value = 'demo.user.two'; q.dispatchEvent(new Event('input', { bubbles: true }));
              const visible = [...document.querySelectorAll('#keypicker [data-kp-id]')].filter(r => !r.hidden).length;
              const btn = [...document.querySelectorAll('#keypicker [data-kp-copy][data-kp-field="password"]')]
                .find(b => !b.closest('[data-kp-id]').hidden);
              if (!btn) return JSON.stringify({ filterVisible: visible, btnFound: false });
              btn.click();
              await new Promise(r => setTimeout(r, 400));
              return JSON.stringify({ filterVisible: visible, btnFound: true, btnText: btn.innerText.trim() });
            })()`).catch(err => 'wired probe failed: ' + err.message);
            console.log('[capture] demo picker wired:', wired, 'clipboard-is-a-demo-password:', clipboard.readText().startsWith('demo-placeholder-'));
            clipboard.clear();
          }
          await new Promise(r => setTimeout(r, 250));
        }
        if (extraWait) await new Promise(r => setTimeout(r, extraWait));
        // UnknownVizError / empty frames clear once the compositor produces a frame — retry
        let img = null; let lastErr = null;
        for (let i = 0; i < 10 && !img; i++) {
          try {
            const candidate = await win.webContents.capturePage();
            if (!candidate.isEmpty()) img = candidate;
          } catch (err) { lastErr = err; }
          if (!img) await new Promise(r => setTimeout(r, 1000));
        }
        try {
          const dockInfo = await win.webContents.executeJavaScript(`(() => {
            const d = document.getElementById('dock-home');
            const l = document.getElementById('left');
            return JSON.stringify({
              dock: !!d,
              leftExists: !!l,
              leftHtmlLen: l ? l.innerHTML.length : -1,
              bodyClass: document.body.className,
              apiExists: typeof window.api !== 'undefined',
              cardCount: document.querySelectorAll('.card').length,
              updatePanel: (() => { const h = [...document.querySelectorAll('.svcgroup .head .name')].find(n => n.textContent === 'Updates'); return h ? h.closest('.svcgroup').innerText.replace(/\\s+/g, ' ').slice(0, 160) : 'MISSING'; })(),
            });
          })()`);
          console.log('[capture] state:', dockInfo);
        } catch (err) { console.error('[capture] state probe failed:', err.message); }
        if (img) {
          const target = path.isAbsolute(outFile) ? outFile : path.join(__dirname, '..', outFile);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, img.toPNG());
          console.log(`[capture] saved ${outFile}`, JSON.stringify(img.getSize()));
          // The active account view is a NATIVE child view: it is absent from the window capture and
          // from PrintWindow. Save it separately so it can be composited at (RAIL_W, TAB_STRIP_H).
          const act = vm.activeKey && vm.tabs.get(vm.activeKey);
          if (act) {
            // same UnknownVizError/empty-frame retry as the window capture
            let vimg = null; let vErr = null;
            for (let i = 0; i < 12 && !vimg; i++) {
              try {
                const cand = await act.view.webContents.capturePage();
                if (!cand.isEmpty()) vimg = cand;
              } catch (err) { vErr = err; }
              if (!vimg) await new Promise(r => setTimeout(r, 1000));
            }
            if (vimg) {
              const vpath = target.replace(/\.png$/i, '.view.png');
              fs.writeFileSync(vpath, vimg.toPNG());
              console.log(`[capture] saved view layer ${path.basename(vpath)}`, JSON.stringify(vimg.getSize()), `offset=${RAIL_W},${TAB_STRIP_H}`);
            } else {
              console.error('[capture] view layer failed:', vErr ? vErr.message : 'empty frames');
            }
          }
        } else {
          console.error('[capture] failed after retries:', lastErr ? lastErr.message : 'empty frames');
        }
        app.exit(0);
      }, 5000);
    });
  }
  win.on('resize', applyBounds);
  win.on('close', () => { vm.hibernateAll(); vm.flushSession(); }); // 'close' fires before destruction — contentView is still usable here

  // keyboard accelerators work even when a webview has focus
  const menu = Menu.buildFromTemplate([
    { label: 'App', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Sleep Tab', accelerator: 'CmdOrCtrl+W', click: () => { if (vm.activeKey) vm.hibernate(vm.activeKey); } },
        { label: 'Sleep All', accelerator: 'CmdOrCtrl+Shift+W', click: () => vm.hibernateAll() },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Tab', click: () => cycleTab(vm, 1) },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => cycleTab(vm, -1) },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Tab ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => { const keys = [...vm.tabs.keys()]; if (keys[i]) vm.activate(keys[i]); },
        })),
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => vm.nav('back') },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => vm.nav('forward') },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => vm.nav('reload') },
        { label: 'Reload', accelerator: 'F5', click: () => vm.nav('reload') },
        { label: 'Dashboard', accelerator: 'Alt+Home', click: () => vm.nav('dashboard') },
        { type: 'separator' },
        { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => { if (win.webContents && !win.webContents.isDestroyed()) win.webContents.send('focus-address'); } },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'zoomReset' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
  ]);
  Menu.setApplicationMenu(menu);

  ipcMain.on('ui-ready', () => {
    if (!vm.sessionRestored) {
      vm.sessionRestored = true;
      const n = vm.restoreSession(); // bring back the tabs that were open at exit
      if (n) console.log(`[session] restored ${n} live tab(s) of ${vm.session.length} remembered`);
      // --open <svc::id>: open and focus one account at startup (demos, screenshots, shortcuts)
      const oi = process.argv.indexOf('--open');
      if (oi > -1 && process.argv[oi + 1]) {
        const [svc, id] = String(process.argv[oi + 1]).split('::');
        const service = serviceByKey(svc);
        if (service) vm.create(svc, id, service.dashboardUrl);
      }
    }
    vm.emitState();
  });
  ipcMain.handle('list-services', () => allServices());
  ipcMain.handle('registry-list', () => store.accounts.map(a => ({ ...a, key: accountKey(a.svc, a.id) })));
  ipcMain.handle('get-settings', () => store.settings);
  ipcMain.handle('set-warm-limit', (_e, n) => {
    store.settings.warmLimit = Math.max(1, Math.min(15, Number(n) || 5));
    store.save();
    vm.enforceWarmLimit();
    vm.emitState();
    return store.settings.warmLimit;
  });
  ipcMain.handle('add-account', (_e, svc, opts = {}) => {
    const service = serviceByKey(svc);
    if (!service) throw new Error(`unknown service: ${svc}`);
    const { id, label, mode } = opts;
    let cleanId = sanitizeId(id || `a${store.accounts.filter(a => a.svc === svc).length + 1}`);
    let n = 2;
    while (findAccount(svc, cleanId)) cleanId = `${sanitizeId(id || 'acc')}-${n++}`; // uniquify: never alias two accounts onto one session
    const url = mode === 'signup' ? (service.signupUrl || service.loginUrl) : service.loginUrl;
    vm.create(svc, cleanId, url, { label: (label || cleanId).trim() });
    return accountKey(svc, cleanId);
  });
  ipcMain.handle('open-account', (_e, svc, id) => {
    const key = accountKey(svc, id);
    if (!vm.tabs.has(key)) {
      if (!findAccount(svc, id)) return null; // never resurrect a deleted account from a stale UI click
      const service = serviceByKey(svc);
      vm.create(svc, id, service.dashboardUrl);
    } else vm.activate(key);
    return key;
  });
  ipcMain.handle('activate-tab', (_e, key) => vm.activate(key));
  ipcMain.handle('nav', (_e, action, url) => vm.nav(String(action || ''), url));
  ipcMain.handle('sleep-tab', (_e, key) => vm.hibernate(key));
  ipcMain.handle('sleep-all', () => vm.hibernateAll());
  ipcMain.handle('update-account', (_e, svc, id, patch) => vm.updateAccount(svc, id, patch || {}));
  ipcMain.handle('delete-account', (_e, svc, id) => vm.deleteAccount(svc, id));
  ipcMain.handle('memory', () => vm.snapshotMemory());
  ipcMain.handle('open-external', (_e, url) => {
    if (!url) return;
    try { const p = new URL(String(url)); if (p.protocol !== 'https:' && p.protocol !== 'http:') return; } catch { return; }
    shell.openExternal(String(url)); // http/https only: never launch arbitrary OS-registered schemes from web content
  });
  ipcMain.handle('set-modal-open', (_e, open) => vm.setModalOpen(!!open));
  ipcMain.handle('show-home', () => {
    vm.deactivate(); // hide views, keep tabs live and warm — instant return to any tab
    return true;
  });
  ipcMain.handle('close-tab', (_e, key) => vm.closeTab(key));

  // ---------- updates ----------
  ipcMain.handle('update-state', () => updater.snapshot());
  ipcMain.handle('update-check', () => updater.check());
  ipcMain.handle('update-download', () => updater.download());
  ipcMain.handle('update-install', () => updater.install());
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('update-set-token', async (_e, plain) => {
    await updater.setToken(plain);
    return updater.check();
  });

  // ---------- saved logins: capture what you type, fill it back later ----------
  function tabForSender(senderWc) {
    for (const [key, t] of vm.tabs) if (t.view.webContents.id === senderWc.id) return { key, tab: t };
    return null;
  }
  ipcMain.on('credential-captured', (e, data) => {
    if (!store.settings.saveLogins) return;
    const found = tabForSender(e.sender);
    if (!found || !data || !data.password) return;
    // A username-less capture (an autofilled form, a stray Enter) must never overwrite a real login
    // for THIS account. Only this account's own captures count — an imported fallback row belongs to
    // no account and must not block the user recording their own login.
    if (!data.username) {
      const own = creds.candidatesForAccount(found.tab.svc, found.tab.id, data.url)
        .some(c => c.accountKey === found.key && c.username);
      if (own) return;
    }
    // Origin guard: only a login typed on the service's OWN domain may be bound to this account.
    // Without this, a password typed on an OAuth/phishing page reached from the tab would overwrite
    // the account's saved login and later be autofilled into the real service.
    if (!originAllowed(found.tab.svc, data.url)) {
      console.warn(`[logins] ignored a credential captured on a foreign origin (${creds.hostOf(data.url)}) for ${found.key}`);
      return;
    }
    try {
      const res = creds.rememberForAccount(found.tab.svc, found.tab.id, data);
      if (res.saved) {
        console.log(`[logins] remembered ${data.username || '(no user)'} for ${found.key}`);
        vm.emitState();
      }
    } catch (err) { console.error('[logins] save failed:', err.message); }
  });
  ipcMain.on('login-form-present', (e, info) => {
    const found = tabForSender(e.sender);
    if (!found) return;
    found.tab.loginForm = !!(info && info.present);
    if (found.tab.loginForm) {
      const pageUrl = (info && info.url) || found.tab.view.webContents.getURL();
      scheduleAutoFill(found.key, found.tab, pageUrl);
    }
    vm.emitState();
  });
  // Fill outcomes from the account preload (0.9.0: the result was ignored in 0.8.0, so a manual fill
  // failed silently and an automatic one was invisible). Resolve the awaiting request, and for an
  // automatic fill raise the banner — "Filled … · Undo" or the honest reason it did not fill.
  ipcMain.on('fill-result', (e, result) => {
    const found = tabForSender(e.sender);
    if (!found) return;
    const entry = vm.settleFill(found.key, result || {});
    if (entry && entry.auto) noticeFromAutoFill(found.key, found.tab, entry.credentialId, result || {});
  });

  // ---- auto-fill: plan -> fill -> announce (0.9.0 C) ----
  // The plan decides everything before anything is typed. It never guesses (D30) and it never fires
  // for an account whose "never auto-fill" switch is on. Runs a touch after the form report so a
  // script-rendered SPA form has settled.
  function scheduleAutoFill(key, tab, pageUrl) {
    const token = (tab.autoFillToken || 0) + 1;
    tab.autoFillToken = token;
    tab.loginPending = { url: pageUrl, at: Date.now() };
    setTimeout(() => {
      if (vm.tabs.get(key) !== tab || tab.autoFillToken !== token) return; // slept, recreated, or a newer form report
      autoFillNow(key, tab, pageUrl).catch(err => console.error('[logins] auto-fill failed:', err.message));
    }, AUTO_FILL_DELAY_MS);
  }

  async function autoFillNow(key, tab, pageUrl) {
    const plan = autoFillPlan(tab.svc, tab.id, pageUrl);
    if (plan.kind === 'skip') {
      // The 0.8.0 defect: an ambiguous page did nothing at all, so the user could not tell a missing
      // login from a broken feature. Ambiguity now raises the chooser banner instead.
      const existing = tab.notice;
      if (!existing || existing.kind !== 'choose') vm.setNotice(key, null);
      return plan;
    }
    if (plan.kind === 'choose') {
      vm.setNotice(key, { kind: 'choose', choices: plan.choices, url: pageUrl });
      return plan;
    }
    const picked = creds.candidatesForAccount(tab.svc, tab.id, pageUrl).find(c => c.id === plan.credentialId);
    if (!picked) return { kind: 'skip', reason: 'unresolved' };
    const result = await pushFill(tab, picked, { auto: true });
    noticeFromAutoFill(key, tab, picked.id, result);
    return { kind: 'fill', requestId: result.requestId, ok: result.ok, reason: result.reason };
  }

  function noticeFromAutoFill(key, tab, credentialId, result) {
    const username = (creds.loadAll().find(c => c.id === credentialId) || {}).username || '';
    if (result.ok) {
      vm.setNotice(key, { kind: 'filled', username, credentialId, fillId: result.requestId, fields: { user: !!result.user, password: !!result.password } });
      return;
    }
    const reasons = {
      'no-form': 'this page shows no sign-in form yet',
      'no-login': 'nothing is saved for this site yet',
      'tab-closed': 'the tab closed before the form answered',
      timeout: 'the page did not answer',
    };
    vm.setNotice(key, { kind: 'failed', username, reason: reasons[result.reason] || 'the page had no visible password field' });
  }

  // Push one credential into a tab and WAIT for the preload's answer, so "filled" is a fact and not
  // an assumption. The timeout exists because a page can navigate mid-fill.
  function pushFill(tab, cred, opts = {}) {
    const requestId = crypto.randomUUID();
    const p = new Promise(resolve => {
      const timer = setTimeout(() => {
        tab.pendingFills.delete(requestId);
        resolve({ ok: false, reason: 'timeout' });
      }, FILL_TIMEOUT_MS);
      tab.pendingFills.set(requestId, { resolve, timer, auto: !!opts.auto, credentialId: cred.id });
    });
    try {
      tab.view.webContents.send('fill-credential', {
        requestId, username: cred.username, password: cred.password, submit: !!opts.submit,
      });
    } catch (err) {
      tab.pendingFills.delete(requestId);
      return Promise.resolve({ ok: false, reason: 'send-failed' });
    }
    return p;
  }

  ipcMain.handle('fill-login', async (_e, key, credentialId = null) => {
    const t = vm.tabs.get(key);
    if (!t) return { ok: false, reason: 'asleep', message: 'That tab is asleep — open it first.' };
    const [svc, id] = key.split('::');
    const pageUrl = t.view.webContents.getURL();
    if (!originAllowed(svc, pageUrl)) {
      return {
        ok: false, reason: 'foreign-host',
        message: `This tab is on ${creds.hostOf(pageUrl) || 'another site'}, not ${serviceHosts(svc)[0] || 'the service'} — refusing to fill a saved password here.`,
      };
    }
    const { candidates } = fillCandidatesFor(svc, id, pageUrl);
    if (!candidates.length) {
      return { ok: false, reason: 'no-login', message: `No saved login for this ${svcOfName(svc)} account yet — sign in once, or import your passwords.` };
    }
    // The user may have navigated since the chooser was rendered. Recompute from the LIVE URL;
    // if the picked id no longer belongs here, return fresh summaries instead of persisting a stale default.
    if (credentialId && !candidates.some(c => c.id === credentialId)) {
      return { choose: summariesOf(candidates, svc, id) };
    }
    const cred = resolveAmong(candidates, accountKey(svc, id), credentialId || null);
    if (!cred) return { choose: summariesOf(candidates, svc, id) };
    if (credentialId) { useAsDefault(svc, id, credentialId); vm.emitState(); } // only a candidate of this account + this service
    const result = await pushFill(t, cred, { submit: false });
    if (result.ok) {
      vm.setNotice(key, { kind: 'filled', username: cred.username, credentialId: cred.id, fillId: result.requestId, fields: { user: !!result.user, password: !!result.password } });
      return { ok: true, filled: cred.username, requestId: result.requestId };
    }
    const messages = {
      'no-form': 'No sign-in form is visible on this page. Sign in once here and it will be filled next time.',
      'tab-closed': 'The tab closed before the form answered.',
      timeout: 'The page did not answer — it may have navigated while filling.',
    };
    return { ok: false, reason: result.reason, message: messages[result.reason] || 'This page has no visible password field to fill.' };
  });
  ipcMain.handle('creds-stats', () => creds.stats());
  ipcMain.handle('creds-browsers', () => creds.listChromiumProfiles().map(p => ({ browser: p.browser, profile: p.profile, id: p.loginData })));
  ipcMain.handle('creds-import-browser', async (_e, id) => {
    const p = creds.listChromiumProfiles().find(x => x.loginData === id);
    if (!p) throw new Error('Browser profile not found');
    const r = await creds.importFromChromium(p);
    vm.emitState();
    return r;
  });
  ipcMain.handle('creds-import-csv', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog({ title: 'Import passwords from CSV', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const res = creds.importFromCsv(r.filePaths[0]);
    vm.emitState();
    return res;
  });
  ipcMain.handle('creds-clear', () => { creds.clearAll(); vm.emitState(); return true; });
  ipcMain.handle('creds-for-account', (_e, svc, id) => {
    const svcCfg = serviceByKey(svc);
    const c = creds.credentialForAccount(svc, id, svcCfg && svcCfg.loginUrl);
    return c ? { username: c.username, host: c.host, source: c.source } : null; // never the password
  });
  // Per-account "Logins" list for the gear modal and the rail badge: summaries only, never passwords.
  ipcMain.handle('creds-account-list', (_e, svc, id) => ({
    logins: accountLoginSummaries(svc, id),
    signInUrl: (serviceByKey(svc) || {}).loginUrl || null,
  }));
  // Per-SITE picker (0.10.0): the logins that can sign you in on the ACTIVE tab's live host. The
  // renderer names the tab; main reads that tab's LIVE url, so the list can never describe a page the
  // user has navigated away from. Summaries only (no `password` key, ever).
  ipcMain.handle('creds-site-list', (_e, key) => {
    const t = key ? vm.tabs.get(String(key)) : null;
    if (!t) return { host: '', logins: [], count: 0, live: false };
    const liveUrl = t.view.webContents.isDestroyed() ? '' : t.view.webContents.getURL();
    const { host, rows } = siteLoginRows(t.svc, t.id, liveUrl);
    return { host, logins: rows, count: rows.length, live: true };
  });
  // Copy a saved email/password to the OS clipboard without ever showing it (main-process clipboard).
  // The account and the site gate come from the ACTIVE tab in main, not from the caller.
  ipcMain.handle('creds-copy', (_e, key, credentialId, field) => {
    const t = key ? vm.tabs.get(String(key)) : null;
    if (!t) return { ok: false, reason: 'asleep', message: 'That tab is asleep — open it first.' };
    const liveUrl = t.view.webContents.isDestroyed() ? '' : t.view.webContents.getURL();
    return copyCredentialField(String(credentialId || ''), String(field || ''), t.svc, t.id, liveUrl);
  });
  // Credential manager: summaries only, never passwords — the renderer must not hold one.
  // Imported passwords are classified by host, with the accounts each row can serve, so the manager
  // filters and the ★ markers both come from the main process (the only authority on them).
  ipcMain.handle('creds-list', () => managerRows());
  ipcMain.handle('creds-default', (_e, credentialId, svc, id, hostHint) =>
    setOrClearDefault(credentialId, svc, id, hostHint));
  ipcMain.handle('creds-delete', (_e, credentialId) => {
    const ok = creds.deleteCredential(credentialId);
    vm.emitState();
    return { ok, rows: managerRows() };
  });
  // Per-account "never auto-fill" switch (0.9.0 C). Stored on the account, default off — the global
  // Auto-fill toggle stays the master and this can only subtract from it, never add.
  ipcMain.handle('account-no-autofill', (_e, svc, id, value) => {
    const acc = findAccount(svc, id);
    if (!acc) throw new Error('unknown account');
    acc.noAutoFill = !!value;
    store.save();
    vm.emitState();
    return acc.noAutoFill;
  });
  // Per-account content override (0.11.0): 'follow' | 'on' | 'off' per control, stored SPARSELY on
  // the account record (see updateContentOverride). 'follow' deletes the key, so clearing restores
  // the account's stored bytes. An override is a TRUE override in both directions (owner decision
  // Q2): it may turn a control on while the app-wide toggle is off, and vice versa. The change is
  // applied to that account's live tab immediately; every other tab is re-resolved and acted on only
  // if ITS value actually moved (an untouched account is never reloaded or re-engaged).
  ipcMain.handle('account-content-override', (_e, svc, id, name, value) =>
    setAccountContentOverride(vm, svc, id, name, value));
  // Dismiss the per-tab notice (banner X).
  ipcMain.handle('dismiss-notice', (_e, key) => { vm.setNotice(key, null); return true; });
  // Undo an auto-fill: the preload clears exactly what it filled and answers with what it cleared.
  // The undo has its own requestId for routing; `fillId` names the fill it is undoing, so a stale
  // Undo (or one aimed at a different fill) is refused by the page instead of clearing live fields.
  ipcMain.handle('undo-fill', async (_e, key) => {
    const t = vm.tabs.get(key);
    if (!t) return { ok: false, reason: 'asleep' };
    const notice = t.notice;
    if (!notice || notice.kind !== 'filled' || !notice.fillId) return { ok: false, reason: 'no-notice' };
    const requestId = crypto.randomUUID();
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => { t.pendingFills.delete(requestId); resolve({ ok: false, reason: 'timeout' }); }, FILL_TIMEOUT_MS);
      t.pendingFills.set(requestId, { resolve, timer, auto: false });
      t.view.webContents.send('clear-filled', { requestId, fillId: notice.fillId });
    });
    if (result.ok) vm.setNotice(key, null);
    return result;
  });
  // The chooser a notice offers: same resolution path as a manual fill, then dismiss the banner.
  ipcMain.handle('notice-choose', async (_e, key, credentialId) => {
    const t = vm.tabs.get(key);
    if (!t) return { ok: false, reason: 'asleep' };
    const [svc, id] = key.split('::');
    const pageUrl = t.view.webContents.getURL();
    const { candidates } = fillCandidatesFor(svc, id, pageUrl);
    const picked = candidates.find(c => c.id === credentialId);
    if (!picked) return { ok: false, reason: 'stale' };
    useAsDefault(svc, id, picked.id);
    vm.emitState();
    const result = await pushFill(t, picked, { submit: false });
    if (result.ok) vm.setNotice(key, { kind: 'filled', username: picked.username, credentialId: picked.id, fillId: result.requestId, fields: { user: !!result.user, password: !!result.password } });
    return result.ok ? { ok: true, filled: picked.username } : { ok: false, reason: result.reason };
  });
  // ---------- Phase 3: service plugins (JSON manifests) ----------
  ipcMain.handle('plugins-list', () => ({
    dir: plugins.pluginsDir(),
    services: pluginServices.map(s => ({
      key: s.key, name: s.name, sourceFile: s.sourceFile, hasApi: !!s.api,
      shadowed: serviceByKey(s.key) !== s, // another service already owns this key
    })),
    errors: pluginErrors,
  }));
  ipcMain.handle('plugin-install', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog({ title: 'Install a service plugin', filters: [{ name: 'Service manifest', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const preview = plugins.validate(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')), path.basename(r.filePaths[0]));
    if (preview.ok) {
      const clash = [...SERVICES, ...(store.customServices || [])].find(s => s.key === preview.service.key);
      if (clash) throw new Error(`"${preview.service.key}" is already used by ${clash.name} — change the plugin's key`);
    }
    const svc = plugins.install(r.filePaths[0]);
    reloadPlugins();
    vm.emitState();
    return svc;
  });
  ipcMain.handle('plugin-remove', (_e, key) => {
    if (store.accounts.some(a => a.svc === key)) throw new Error('Delete this service’s accounts first');
    plugins.remove(key);
    reloadPlugins();
    vm.emitState();
    return true;
  });
  ipcMain.handle('plugin-write-example', () => {
    fs.mkdirSync(plugins.pluginsDir(), { recursive: true });
    const p = path.join(plugins.pluginsDir(), 'example-flyio.json.txt');
    fs.writeFileSync(p, JSON.stringify(plugins.EXAMPLE, null, 2));
    shell.showItemInFolder(p);
    return p;
  });

  // ---------- Phase 2: user-added generic services (any URL) ----------
  ipcMain.handle('add-service', (_e, { name, url }) => {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Name is required');
    let parsed;
    try { parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { throw new Error('Enter a valid URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs are supported');
    let key = sanitizeId(clean);
    if (serviceByKey(key)) { let n = 2; while (serviceByKey(`${key}-${n}`)) n++; key = `${key}-${n}`; }
    const svc = {
      key, name: clean.slice(0, 40),
      dashboardUrl: parsed.href, loginUrl: parsed.href, signupUrl: parsed.href,
      color: COLORS[(store.customServices.length + SERVICES.length) % COLORS.length],
      multiAccountPolicy: 'ok', custom: true,
    };
    store.customServices.push(svc);
    store.save();
    refreshManagedHosts();
    vm.emitState();
    return svc;
  });
  ipcMain.handle('remove-service', (_e, key) => {
    const svc = (store.customServices || []).find(s => s.key === key);
    if (!svc) throw new Error('Only user-added services can be removed');
    if (store.accounts.some(a => a.svc === key)) throw new Error('Delete this service’s accounts first');
    store.customServices = store.customServices.filter(s => s.key !== key);
    store.save();
    vm.emitState();
    return true;
  });
  ipcMain.handle('set-content-setting', (_e, name, value) => setGlobalContentSetting(vm, name, value));
  ipcMain.handle('content-stats', () => ({
    blocked: content.stats.blocked,
    listSource: content.filters.loadedFrom,
    hosts: content.filters.hosts.size,
    cosmetic: content.filters.cosmetic.length,
  }));
  ipcMain.handle('set-group-tabs', (_e, on) => {
    store.settings.groupTabs = !!on;
    store.save();
    vm.emitState();
    return store.settings.groupTabs;
  });
  ipcMain.handle('toggle-collapsed', (_e, svc, scope = 'rail') => {
    const field = scope === 'strip' ? 'stripCollapsed' : 'collapsed'; // rail and strip collapse independently
    const set = new Set(store.settings[field] || []);
    if (set.has(svc)) set.delete(svc); else set.add(svc);
    store.settings[field] = [...set];
    store.save();
    vm.emitState();
    return store.settings[field];
  });

  // ---------- API-token layer (tokens stay in main; renderer gets summaries only) ----------
  async function refreshAccountStatus(svc, id) {
    const key = accountKey(svc, id);
    const provider = providerFor(svc);
    const token = await tokens.getToken(key);
    if (!provider || !token) return;
    try {
      const { summary } = await provider.validate(token);
      statusCache.set(key, { summary, error: null, fetchedAt: Date.now() });
      tokens.markValidated(key, null);
    } catch (err) {
      const msg = err.message === 'TOKEN_INVALID' ? 'token invalid or expired' : err.message;
      statusCache.set(key, { summary: null, error: msg, fetchedAt: Date.now() });
      if (err.message === 'TOKEN_INVALID') tokens.markValidated(key, msg);
    }
  }

  ipcMain.handle('set-account-token', async (_e, svc, id, plain) => {
    const key = accountKey(svc, id);
    if (!providerFor(svc)) throw new Error(`unknown service: ${svc}`);
    if (!plain || !plain.trim()) throw new Error('empty token');
    const provider = providerFor(svc);
    try {
      const { summary } = await provider.validate(plain.trim()); // validate BEFORE storing
      await tokens.setToken(key, plain.trim());
      tokens.markValidated(key, null);
      statusCache.set(key, { summary, error: null, fetchedAt: Date.now() });
      vm.emitState();
      return { ok: true, summary };
    } catch (err) {
      const msg = err.message === 'TOKEN_INVALID' ? 'token rejected by the service (invalid or lacking read scope)' : `could not validate: ${err.message}`;
      vm.emitState();
      throw new Error(msg);
    }
  });
  ipcMain.handle('clear-account-token', async (_e, svc, id) => {
    const key = accountKey(svc, id);
    await tokens.clearToken(key);
    statusCache.delete(key);
    vm.emitState();
    return true;
  });
  ipcMain.handle('refresh-all-status', async () => {
    const withTokens = store.accounts.filter(a => tokens.tokenMeta(accountKey(a.svc, a.id)));
    const CONC = 4;
    for (let i = 0; i < withTokens.length; i += CONC) {
      await Promise.all(withTokens.slice(i, i + CONC).map(a => refreshAccountStatus(a.svc, a.id)));
    }
    vm.emitState();
    return withTokens.length;
  });
  ipcMain.handle('smoke-token-roundtrip', async (_e, svc, id, plain) => {
    // verification-only path (used by --smoke-tokens): exercises storage without touching the network
    await tokens.setToken(accountKey(svc, id), plain);
    const back = await tokens.getToken(accountKey(svc, id));
    const meta = tokens.tokenMeta(accountKey(svc, id));
    await tokens.clearToken(accountKey(svc, id));
    const gone = await tokens.getToken(accountKey(svc, id));
    return { roundtrip: back === plain, meta, cleared: gone === null };
  });
  ipcMain.handle('active-tab-url', () => {
    const t = vm.tabs.get(vm.activeKey);
    return t ? t.url : null;
  });
}

// Test-only exports (used by the smoke modes). These are the exact functions the IPC handlers above
// call — smoke proves the real projection, not a copy of it.
module.exports = {
  accountLoginSummaries, managerRows, setOrClearDefault, resolveAmong, fillCandidatesFor, autoFillPlan,
  originAllowed, accountKey,
  resolveContent, updateContentOverride, contentOverrideFor,
  setAccountContentOverride, setGlobalContentSetting, applyContentToFreshDocument, reactToContentChange, contentSnapshot,
  _creds: creds,
};

function cycleTab(vm, dir) {
  const keys = [...vm.tabs.keys()];
  if (!keys.length) return;
  const idx = vm.activeKey ? keys.indexOf(vm.activeKey) : 0;
  const next = keys[(idx + dir + keys.length) % keys.length];
  vm.activate(next);
}

// test modes default to an isolated userData: they can never pollute the real registry/partitions
const TEST_FLAGS = ['--spike', '--smoke', '--smoke-restore', '--smoke-tokens', '--smoke-creds', '--smoke-autofill', '--smoke-updates', '--smoke-services', '--smoke-dark'];
const testFlag = TEST_FLAGS.find(f => process.argv.includes(f));
if (testFlag && !process.env.MAM_USER_DATA) {
  const dirName = testFlag === '--smoke-restore' ? 'mam-test-smoke' : `mam-test-${testFlag.slice(2)}`;
  app.setPath('userData', path.join(app.getPath('temp'), dirName)); // smoke and smoke-restore share a dir by design
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(testFlag ? 3 : 0); // test modes must fail loudly (non-zero) when another instance holds the lock
} else {
  app.on('second-instance', () => {
    const [w] = BaseWindow.getAllWindows();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.whenReady().then(async () => {
    // --print-paths: where does this build keep its data? (support + rename verification)
    if (process.argv.includes('--print-paths')) {
      console.log(JSON.stringify({
        appName: app.getName(),
        version: app.getVersion(),
        userData: app.getPath('userData'),
        partitions: path.join(app.getPath('userData'), 'Partitions'),
      }, null, 2));
      return app.exit(0);
    }
    store.load();
    // --seed-demo-logins: placeholder accounts + logins, for screenshots of a scratch profile only.
    // Requires MAM_USER_DATA (a scratch dir): it must never touch the real profile.
    if (process.argv.includes('--seed-demo-logins')) {
      if (!process.env.MAM_USER_DATA) {
        console.error('[demo] --seed-demo-logins refuses to run without MAM_USER_DATA — point it at a scratch profile');
        return app.exit(2);
      }
      // Wait for safeStorage to become ready before touching credentials.js. On this machine the
      // OS key is not available during app.whenReady() yet (credentials.js checks
      // isEncryptionAvailable()); a listCredentials() call before that answers [] and caching that
      // empty answer is exactly how the manager could show "0 stored" for a full profile.
      const { safeStorage } = require('electron');
      const deadline = Date.now() + 8000;
      while (!safeStorage.isEncryptionAvailable() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      console.log(`[demo] safeStorage available: ${safeStorage.isEncryptionAvailable()}`);
      seedDemoLogins();
      if (!process.argv.includes('--capture')) return app.exit(0);
    }
    if (process.argv.includes('--spike')) runSpike().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke')) runSmoke().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-restore')) runSmokeRestore().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-tokens')) runSmokeTokens().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-creds')) runSmokeCreds().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-autofill')) runSmokeAutofill().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-updates')) runSmokeUpdates().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-services')) runSmokeServices().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-dark')) runSmokeDark().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--capture')) runInteractive(true);
    else runInteractive();
  });
}
app.on('window-all-closed', () => app.quit());
