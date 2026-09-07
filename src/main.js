const { app, BaseWindow, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const SERVICES = require('./services');
const tokens = require('./api-tokens');
const { PROVIDERS } = require('./providers');

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
  settings: { warmLimit: 5, groupTabs: false, collapsed: [] },
  openTabs: [], // session memory: [{svc, id, url, lastActivated, active}] — survives restarts
  save() {
    writeJson(userDataPath('accounts.json'), this.accounts);
    writeJson(userDataPath('settings.json'), this.settings);
  },
  saveSession() { writeJson(userDataPath('session.json'), this.openTabs); },
  load() {
    this.accounts = readJson(userDataPath('accounts.json'), []);
    this.settings = Object.assign({ warmLimit: 5, groupTabs: false, collapsed: [] }, readJson(userDataPath('settings.json'), {}));
    this.openTabs = readJson(userDataPath('session.json'), []);
  },
};
function userData(name) { return userDataPath(name); }

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
    store.saveSession();
  }

  // Restore the tab set from the previous run: most-recent tabs come back live (bounded by warmLimit),
  // the rest appear in the strip asleep and load on click.
  restoreSession() {
    const saved = (store.openTabs || []).filter(s => findAccount(s.svc, s.id)); // skip deleted accounts
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
    const service = SERVICES.find(s => s.key === svc);
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
    let excess = warm.length - (limit - 1); // active tab occupies one warm slot
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

  hibernateAll() { for (const k of [...this.tabs.keys()]) this.hibernate(k); }

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
  win.loadFile(path.join(__dirname, 'ui.html'));
  // auto-update (packaged builds only; releases are published by the GitHub Actions tag workflow)
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.checkForUpdatesAndNotify().catch(err => console.error('auto-update check failed:', err.message));
      setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 4 * 60 * 60 * 1000);
    } catch (err) { console.error('auto-update unavailable:', err.message); }
  }
  const applyBounds = () => {
    const [w, h] = win.getContentSize();
    // reserve the left rail: account views start after it, so the rail (and Home) is always reachable
    vm.setBounds({ x: RAIL_W, y: TAB_STRIP_H, width: Math.max(0, w - RAIL_W), height: h - TAB_STRIP_H });
  };
  win.once('ready-to-show', () => { applyBounds(); if (!captureMode) win.show(); });
  if (captureMode) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${path.basename(String(sourceId))}:${line})`);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
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
            });
          })()`);
          console.log('[capture] state:', dockInfo);
        } catch (err) { console.error('[capture] state probe failed:', err.message); }
        if (img) {
          fs.writeFileSync(path.join(__dirname, '..', 'ui-screenshot.png'), img.toPNG());
          console.log('[capture] saved ui-screenshot.png', JSON.stringify(img.getSize()));
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
    }
    vm.emitState();
  });
  ipcMain.handle('list-services', () => SERVICES);
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
    const service = SERVICES.find(s => s.key === svc);
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
      const service = SERVICES.find(s => s.key === svc);
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
  ipcMain.handle('set-group-tabs', (_e, on) => {
    store.settings.groupTabs = !!on;
    store.save();
    vm.emitState();
    return store.settings.groupTabs;
  });
  ipcMain.handle('toggle-collapsed', (_e, svc) => {
    const set = new Set(store.settings.collapsed || []);
    if (set.has(svc)) set.delete(svc); else set.add(svc);
    store.settings.collapsed = [...set];
    store.save();
    vm.emitState();
    return store.settings.collapsed;
  });

  // ---------- API-token layer (tokens stay in main; renderer gets summaries only) ----------
  async function refreshAccountStatus(svc, id) {
    const key = accountKey(svc, id);
    const provider = PROVIDERS[svc];
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
    if (!PROVIDERS[svc]) throw new Error(`unknown service: ${svc}`);
    if (!plain || !plain.trim()) throw new Error('empty token');
    const provider = PROVIDERS[svc];
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
const TEST_FLAGS = ['--spike', '--smoke', '--smoke-restore', '--smoke-tokens'];
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
    else if (process.argv.includes('--capture')) runInteractive(true);
    else runInteractive();
  });
}
app.on('window-all-closed', () => app.quit());
