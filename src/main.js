const { app, BaseWindow, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const SERVICES = require('./services');
const tokens = require('./api-tokens');
const { PROVIDERS } = require('./providers');
const content = require('./content');
const creds = require('./credentials');
const plugins = require('./plugins');
const updater = require('./updater');

const statusCache = new Map(); // accountKey -> { summary?, error?, fetchedAt } — summaries only, tokens never leave main

const TAB_STRIP_H = 48;
const RAIL_W = 240; // left account rail — account views must never cover it (must match --rail in ui.html)
const SETTLE_MS = Number(process.env.SPIKE_SETTLE_MS || 8000);
const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#00a2c7', '#4f8cff', '#8e4ec6', '#e93d82', '#6e56cf', '#00b0a0'];
const permissionConfigured = new WeakSet(); // one permission policy per partition session

if (process.env.MAM_USER_DATA) app.setPath('userData', process.env.MAM_USER_DATA);

// ---------- persistence ----------
function userDataPath(name) { return path.join(app.getPath('userData'), name); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const store = {
  accounts: [], // {svc, id, label, colorIdx, proxy, createdAt, lastState}
  settings: { warmLimit: 5, groupTabs: false, collapsed: [], stripCollapsed: [], adBlock: true, darkMode: true, forceDark: false, saveLogins: true, autofill: true },
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
    this.settings = Object.assign({ warmLimit: 5, groupTabs: false, collapsed: [], stripCollapsed: [], adBlock: true, darkMode: true, forceDark: false, saveLogins: true, autofill: true }, readJson(userDataPath('settings.json'), {}));
    this.openTabs = readJson(userDataPath('session.json'), []);
    this.customServices = readJson(userDataPath('services.json'), []);
  },
};
function userData(name) { return userDataPath(name); }

// Built-in curated services + user-added generic ones (Phase 2) + plugin manifests (Phase 3).
let pluginServices = [];
let pluginErrors = [];
function refreshManagedHosts() {
  const hosts = new Set();
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
  return [...new Set([s.dashboardUrl, s.loginUrl, s.signupUrl].filter(Boolean).map(u => creds.hostOf(u)).filter(Boolean))];
}
function originAllowed(svcKey, url) {
  const host = creds.hostOf(url || '');
  if (!host) return false;
  return serviceHosts(svcKey).some(h => creds.hostRelated(host, h));
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
    for (const t of this.tabs.values()) if (t.visible) t.view.setBounds(b);
  }

  setModalOpen(open) {
    this.modalOpen = !!open;
    if (open) {
      // account views are native children that paint ABOVE the chrome DOM: hide them so the modal is reachable
      for (const t of this.tabs.values()) if (t.visible) { t.view.setVisible(false); t.visible = false; }
    } else if (this.activeKey && this.tabs.has(this.activeKey)) {
      const t = this.tabs.get(this.activeKey);
      t.view.setBounds(this.contentBounds);
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
    content.attachAdBlock(ses, () => !!store.settings.adBlock); // network-level ad/tracker blocking per partition
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
    const tab = { view, svc, id, url: url || service.dashboardUrl, visible: false, title: '', lastState: acc.lastState || 'unknown', lastActivated: Date.now() };
    this.tabs.set(key, tab);
    this.trackSession(svc, id, tab.url); // tab joins the remembered open set
    this.window.contentView.addChildView(view);
    if (show) this.activate(key);
    view.webContents.loadURL(tab.url).catch(err => console.error(`load failed ${key}:`, err.message));
    view.webContents.on('page-title-updated', (_e, title) => { tab.title = title; this.emitState(); });
    // Escape must reach Home even while the dashboard page has focus (the renderer's keydown
    // handler only sees events when the chrome DOM is focused).
    view.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !this.modalOpen) this.deactivate();
    });
    view.webContents.on('did-finish-load', () => {
      content.applyToPage(view.webContents, { adBlock: !!store.settings.adBlock, forceDark: !!store.settings.forceDark });
    });
    const onNav = (_e, url2) => {
      tab.url = url2;
      // conservative sign-in heuristic: sitting on the service's login page means not signed in
      tab.lastState = url2.startsWith(service.loginUrl) ? 'signin' : 'ok';
      const a = findAccount(svc, id);
      if (a) { a.lastState = tab.lastState; store.save(); }
      this.emitState();
    };
    view.webContents.on('did-navigate', onNav);
    view.webContents.on('did-navigate-in-page', onNav); // dashboards route client-side (pushState) — must track too
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
      if (vis && !t.visible) { t.view.setBounds(this.contentBounds); t.view.setVisible(true); t.visible = true; }
      else if (!vis && t.visible) { t.view.setVisible(false); t.visible = false; }
    }
    tab.lastActivated = Date.now();
    this.activeKey = key;
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
    try { this.window.contentView.removeChildView(tab.view); } catch {}
    try { tab.view.webContents.close(); } catch {} // separate: a dead contentView must not skip closing the renderer
    this.tabs.delete(key);
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
      try { this.window.contentView.removeChildView(this.tabs.get(key).view); this.tabs.get(key).view.webContents.close(); } catch {}
      this.tabs.delete(key);
    }
    this.untrackSession(svc, id); // also drop it from the remembered tab set
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
    this.window.webContents.send('tabs-state', {
      activeKey: this.activeKey,
      warmLimit: store.settings.warmLimit,
      registry: store.accounts.map(a => ({
        ...a,
        key: accountKey(a.svc, a.id),
        hasToken: !!tokens.tokenMeta(accountKey(a.svc, a.id)),
        status: statusCache.get(accountKey(a.svc, a.id)) || null,
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
          lastState: t ? t.lastState : (a.lastState || 'unknown'),
        };
      }),
    });
  }

  snapshotMemory() {
    const metrics = app.getAppMetrics();
    let totalWS = 0; const byType = {};
    for (const m of metrics) {
      const ws = (m.memory && m.memory.workingSetSize) || 0;
      totalWS += ws;
      byType[m.type] = (byType[m.type] || 0) + 1;
    }
    return { totalWorkingSetKB: totalWS, totalMB: Math.round(totalWS / 1024), processes: byType, liveTabs: this.tabs.size };
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

    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'credentials.json'), 'utf8');
    check('encrypted-at-rest', !raw.includes('hunter2') && !raw.includes('typed-pw'));

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
  tab.view.webContents.send('fill-credential', { username: cred.username, password: cred.password, submit: false });
  await sleep(800);
  const filled = await tab.view.webContents.executeJavaScript(
    `({ email: document.querySelector('[name=email]').value, pw: document.querySelector('[name=pw]').value })`);
  check('fill-username', filled.email === 'me@example.com', filled.email);
  check('fill-password', filled.pw === 'p@ss-fill', filled.pw ? '(set)' : '(empty)');

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

  const s = await updater.check();
  check('check-completes-with-a-verdict', ['available', 'up-to-date', 'error'].includes(s.status), `status=${s.status}`);
  console.log(`[smoke:updates] INFO latest=${s.latestVersion || 'n/a'} error=${s.error || 'none'}`);
  // A private repo returns 404 unauthenticated — the message must say so rather than being cryptic.
  if (s.status === 'error') check('error-is-actionable', /private|release|network|token/i.test(s.error || ''), s.error);

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
  content.setNativeDark(!!store.settings.darkMode); // sites with their own dark theme follow it
  content.loadFilters().then(src => console.log(`[adblock] filters from ${src}: ${content.filters.hosts.size} hosts, ${content.filters.cosmetic.length} cosmetic`));
  win.loadFile(path.join(__dirname, 'ui.html'));
  // Update system: version tracking + release info + explicit user-driven download/install.
  // Nothing downloads or installs on its own; the UI shows what is available and you decide.
  updater.init(s => { if (win && win.webContents && !win.webContents.isDestroyed()) win.webContents.send('update-state', s); });
  updater.check().catch(() => {});                                     // one check at startup
  setInterval(() => updater.check().catch(() => {}), 4 * 60 * 60 * 1000); // and every 4 hours
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
    const argVal = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
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
  win.on('close', () => { vm.hibernateAll(); }); // 'close' fires before destruction — contentView is still usable here

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
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'zoomReset' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
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
    // auto-fill this account's own remembered login when its sign-in page appears
    if (found.tab.loginForm && store.settings.autofill) {
      const pageUrl = (info && info.url) || found.tab.view.webContents.getURL();
      if (!originAllowed(found.tab.svc, pageUrl)) {
        vm.emitState();
        return; // never auto-type a password into a page that is not the service's own site
      }
      const cred = creds.forAccount(found.tab.svc, found.tab.id, pageUrl);
      if (cred) e.sender.send('fill-credential', { username: cred.username, password: cred.password, submit: false });
    }
    vm.emitState();
  });
  ipcMain.on('fill-result', () => {});

  ipcMain.handle('fill-login', (_e, key) => {
    const t = vm.tabs.get(key);
    if (!t) throw new Error('That tab is asleep — open it first');
    const [svc, id] = key.split('::');
    const pageUrl = t.view.webContents.getURL();
    if (!originAllowed(svc, pageUrl)) {
      throw new Error(`This tab is on ${creds.hostOf(pageUrl) || 'another site'}, not ${serviceHosts(svc)[0] || 'the service'} — refusing to fill a saved password here`);
    }
    const cred = creds.forAccount(svc, id, pageUrl);
    if (!cred) throw new Error('No saved login for this account yet — sign in once and it will be remembered');
    t.view.webContents.send('fill-credential', { username: cred.username, password: cred.password, submit: false });
    return true;
  });
  ipcMain.handle('creds-stats', () => creds.stats());
  ipcMain.handle('creds-browsers', () => creds.listChromiumProfiles().map(p => ({ browser: p.browser, profile: p.profile, id: p.loginData })));
  ipcMain.handle('creds-import-browser', async (_e, id) => {
    const p = creds.listChromiumProfiles().find(x => x.loginData === id);
    if (!p) throw new Error('Browser profile not found');
    return creds.importFromChromium(p);
  });
  ipcMain.handle('creds-import-csv', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog({ title: 'Import passwords from CSV', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return creds.importFromCsv(r.filePaths[0]);
  });
  ipcMain.handle('creds-clear', () => creds.clearAll());
  ipcMain.handle('creds-for-account', (_e, svc, id) => {
    const svcCfg = serviceByKey(svc);
    const c = creds.forAccount(svc, id, svcCfg && svcCfg.loginUrl);
    return c ? { username: c.username, host: c.host, source: c.source } : null; // never the password
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
  ipcMain.handle('set-content-setting', (_e, name, value) => {
    if (!['adBlock', 'darkMode', 'forceDark', 'saveLogins', 'autofill'].includes(name)) throw new Error(`unknown setting: ${name}`);
    store.settings[name] = !!value;
    // Inverting a page that is already dark produces a washed-out light page, so the two modes
    // are mutually exclusive.
    if (name === 'forceDark' && value) store.settings.darkMode = false;
    if (name === 'darkMode' && value) store.settings.forceDark = false;
    store.save();
    content.setNativeDark(!!store.settings.darkMode);
    // re-apply to every live tab so the change is visible immediately
    for (const t of vm.tabs.values()) {
      if ((name === 'forceDark' || name === 'adBlock') && !value) t.view.webContents.reload(); // injected CSS can only be undone by reloading
      else content.applyToPage(t.view.webContents, { adBlock: !!store.settings.adBlock, forceDark: !!store.settings.forceDark });
    }
    vm.emitState();
    return store.settings[name];
  });
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

function cycleTab(vm, dir) {
  const keys = [...vm.tabs.keys()];
  if (!keys.length) return;
  const idx = vm.activeKey ? keys.indexOf(vm.activeKey) : 0;
  const next = keys[(idx + dir + keys.length) % keys.length];
  vm.activate(next);
}

// test modes default to an isolated userData: they can never pollute the real registry/partitions
const TEST_FLAGS = ['--spike', '--smoke', '--smoke-restore', '--smoke-tokens', '--smoke-creds', '--smoke-autofill', '--smoke-updates'];
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
  app.whenReady().then(() => {
    store.load();
    if (process.argv.includes('--spike')) runSpike().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke')) runSmoke().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-restore')) runSmokeRestore().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-tokens')) runSmokeTokens().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-creds')) runSmokeCreds().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-autofill')) runSmokeAutofill().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--smoke-updates')) runSmokeUpdates().catch(err => { console.error(err); app.exit(1); });
    else if (process.argv.includes('--capture')) runInteractive(true);
    else runInteractive();
  });
}
app.on('window-all-closed', () => app.quit());
