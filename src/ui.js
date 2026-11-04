let services = [];
let registry = [];
let state = { activeKey: null, warmLimit: 5, tabs: [], groupTabs: false, collapsed: [] };
let filterText = '';
let credStats = null;
// 0.13.0: the honest notice about an old-format saved-login store that this machine cannot read.
// Main owns the fact (it re-reads the store each time); the renderer only draws it and remembers a
// dismissal FOR THIS LAUNCH, so it returns at the next start while the old store is still there.
let credStoreState = { notice: null, error: null };
let storeNoticeDismissed = false;
let updateState = { status: 'idle', currentVersion: '' };

const $tabctl = document.getElementById('tabctl');
const $tabs = document.getElementById('tabs');
const $mem = document.getElementById('mem');
const $home = document.getElementById('home');
const $modalBack = document.getElementById('modal-back');
const $modal = document.getElementById('modal');
const $infobar = document.getElementById('infobar');
const $extBtn = document.getElementById('ext-btn');
const $hibAll = document.getElementById('hib-all');
const $railTop = document.getElementById('railtop');
const $railScroll = document.getElementById('railscroll');
const $railFoot = document.getElementById('railfoot');
const $keysite = document.getElementById('keysite');
const $keyPicker = document.getElementById('keypicker');
const $keyPickerBack = document.getElementById('keypicker-back');

// Lucide-style stroke icons (no emoji — see ui-ux-pro-max pre-delivery checklist)
const ICONS = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowLeft: '<path d="M19 12H5m7-7-7 7 7 7"/>',
  arrowRight: '<path d="M5 12h14m-7-7 7 7-7 7"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  dashboard: '<path d="M4 5h16v14H4zM4 10h16M9 10v9"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>',
  play: '<path d="m7 4 13 8-13 8V4Z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M4 21v-5M4 10V3M20 21v-7M20 8V3M12 21v-9M12 6V3M1.5 16h5M17.5 14h5M9.5 6h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 17 9 5 9-5"/><path d="m3 12 9 5 9-5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  shield: '<path d="M12 3l8 3v6c0 4.6-3.2 8.4-8 9-4.8-.6-8-4.4-8-9V6l8-3Z"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18Z" fill="currentColor" stroke="none"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 8-8"/><path d="m16 7 2.5 2.5"/><path d="m19 4 2 2"/>',
  download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
};
function icon(n) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`; }

const PALETTE = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#00a2c7', '#4f8cff', '#8e4ec6', '#e93d82', '#6e56cf', '#00b0a0'];
function colorOf(colorIdx, svcKey) {
  if (typeof colorIdx === 'number') return PALETTE[colorIdx % PALETTE.length];
  const s = services.find(x => x.key === svcKey);
  return s ? s.color : '#888';
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function svcOf(key) { return services.find(s => s.key === key) || { key, name: key, color: '#888' }; }
function isCollapsed(svc) { return (state.collapsed || []).includes(svc); }
function isStripCollapsed(svc) { return (state.stripCollapsed || []).includes(svc); }

// Rail/Home grouping for built-in services (services.js `category`); custom + plugin services fall into 'other'.
const CATEGORIES = [
  ['hosting', 'Hosting & deploy'], ['data', 'Databases'], ['code', 'Code & packages'], ['payments', 'Payments'],
  ['google', 'Google'], ['microsoft', 'Microsoft'], ['mail', 'Mail'], ['cloud', 'Cloud'], ['ai', 'AI'], ['other', 'Other'],
];
function categoryOf(s) { return CATEGORIES.some(([k]) => k === s.category) ? s.category : 'other'; }
function categoryLabel(k) { const c = CATEGORIES.find(([key]) => key === k); return c ? c[1] : 'Other'; }
// A service earns a rail row / Home group once it has an account (or the user added it by hand).
function hasPresence(s) { return s.custom || registry.some(a => a.svc === s.key); }

const POLICY_TEXT = {
  ok: '',
  warn: 'multi-accounting is watched here — use judgment',
  'one-per-person': 'ToS: one account per person — orgs/workspaces are the sanctioned way',
};

// ============ top strip: OPEN TABS ONLY ============
function renderTabCtl() {
  $tabctl.innerHTML = `
    <span class="filterwrap">${icon('search')}
      <input id="filter" type="text" placeholder="Filter tabs" value="${esc(filterText)}" aria-label="Filter open tabs" />
    </span>
    <button class="ctlbtn ${state.groupTabs ? 'on' : ''}" id="group-btn" title="Group open tabs by provider">${icon('layers')}</button>`;
}

function tabMatchesFilter(t) {
  if (!filterText) return true;
  const q = filterText.toLowerCase();
  return t.label.toLowerCase().includes(q) || svcOf(t.svc).name.toLowerCase().includes(q);
}

function tabHtml(t) {
  const c = colorOf(t.colorIdx, t.svc);
  const s = svcOf(t.svc);
  const sig = t.lastState === 'signin' ? '<span class="sig" title="Sign-in needed"></span>' : '';
  const cls = `tab${t.key === state.activeKey ? ' active' : ''}${t.live ? '' : ' asleep'}`;
  const title = t.live ? esc(t.url || '') : `Asleep — click to resume · ${esc(t.url || '')}`;
  return `<div class="${cls}" data-key="${esc(t.key)}" title="${title}">
    <span class="dot" style="background:${c}"></span>${sig}
    <span class="label">${esc(s.name)} · ${esc(t.label)}</span>
    <button class="tabx" data-close="${esc(t.key)}" title="Close tab (removes it from the strip)" aria-label="Close tab">${icon('x')}</button>
  </div>`;
}

// ============ browser-style navigation for the active tab ============
const $nav = document.getElementById('nav');
const $addr = document.getElementById('addr');
function renderNav() {
  const t = state.activeKey !== null ? state.tabs.find(x => x.key === state.activeKey) : null;
  $nav.hidden = !t;
  if (!t) return;
  document.getElementById('nav-back').disabled = !t.canGoBack;
  document.getElementById('nav-fwd').disabled = !t.canGoForward;
  const reload = document.getElementById('nav-reload');
  reload.innerHTML = icon(t.loading ? 'stop' : 'refresh');
  reload.title = t.loading ? 'Stop loading' : 'Reload (Ctrl+R / F5)';
  reload.dataset.action = t.loading ? 'stop' : 'reload';
  $addr.classList.toggle('loading', !!t.loading);
  if (document.activeElement !== $addr) $addr.value = t.url || ''; // never clobber what the user is typing
  renderKeyChip();
}

// ============ per-site login picker (0.10.0) ============
// The chip shows how many saved logins can sign you in on the ACTIVE tab's live host — main computes
// both the count and the rows from the tab's live URL, so the renderer never decides what "this site"
// means. Nothing here ever holds a password: Use asks main to fill, Copy asks main to put it on the
// clipboard, and both answers are summaries.
let keyPicker = null; // { key, host, logins } while open
let keyPickerRequest = 0; // cancels stale fetches when the picker closes or another tab is selected
let keyPickerModalOpen = false; // mirrors the native-view hide/show handshake
function renderKeyChip() {
  const sl = state.siteLogins;
  const show = !!(sl && state.activeKey !== null && sl.key === state.activeKey && sl.count > 0);
  $keysite.hidden = !show;
  $keysite.classList.toggle('on', !!(show && keyPicker && keyPicker.key === state.activeKey));
  if (!show) return;
  $keysite.innerHTML = `${icon('key')}<span>${sl.count}</span>`;
  $keysite.title = `${sl.count} saved login${sl.count === 1 ? '' : 's'} for ${sl.host || 'this site'} — click to pick one`;
  $keysite.setAttribute('aria-label', $keysite.title);
}
function keyPickerRowHtml(l) {
  const meta = `${esc(l.host) || 'no site recorded'} · ${esc(l.source)}`
    + (l.accountLabel ? ` · <span class="own">for ${esc(l.accountLabel)}</span>`
      : l.own ? ' · <span class="own">saved for this account</span>' : '');
  return `<div class="kp-row" data-kp-id="${esc(l.id)}" data-search="${esc(`${l.username} ${l.host} ${l.source} ${l.accountLabel || ''}`.toLowerCase())}">
    <span class="kp-who">${esc(l.username || '(no username)')}${l.isDefault ? ' <span class="star" title="This account’s default — auto-fill uses it first">★</span>' : ''}</span>
    <span class="kp-acts">
      <button class="kp-use" data-kp-use="${esc(l.id)}" title="Fill this login into the page and make it this account’s default">Use</button>
      <button class="btn-plain" data-kp-copy="${esc(l.id)}" data-kp-field="username" title="Copy this login’s email to the clipboard — it is never shown here">Copy email</button>
      <button class="btn-plain" data-kp-copy="${esc(l.id)}" data-kp-field="password" title="Copy this login’s password straight to the clipboard — it is never shown here">Copy password</button>
    </span>
    <span class="kp-meta">${meta}</span>
  </div>`;
}
async function openKeyPicker() {
  const key = state.activeKey;
  if (key === null) return;
  const request = ++keyPickerRequest;
  // Mark the picker open immediately so a second click closes/cancels it instead of starting a
  // competing fetch. The loading panel remains visible as soon as the user clicks the chip.
  keyPicker = { key, host: '', logins: [], loading: true };
  $keyPickerBack.hidden = false;
  $keyPicker.hidden = false;
  $keyPicker.innerHTML = '<div class="kp-note">Loading saved logins…</div>';
  // Account WebContentsViews are native children and paint above the chrome DOM. Hide the active
  // view first, just as setModalOpen does for the gear window, or this popover is invisible.
  try { await window.api.setModalOpen(true); keyPickerModalOpen = true; }
  catch (err) {
    closeKeyPicker();
    showNotice(key, { kind: 'failed', reason: `Could not open the saved-login picker: ${errText(err)}` });
    return;
  }
  if (request !== keyPickerRequest || state.activeKey !== key) { await closeKeyPicker(); return; }
  let data = { host: '', logins: [] };
  try { data = await window.api.credsSiteList(key); } catch (err) { data = { host: '', logins: [], error: errText(err) }; }
  if (request !== keyPickerRequest || state.activeKey !== key) { await closeKeyPicker(); return; }
  keyPicker = { key, host: data.host, logins: data.logins || [], loading: false };
  drawKeyPicker();
  const q = $keyPicker.querySelector('#kp-q');
  if (q) q.focus();
}
function drawKeyPicker() {
  if (!keyPicker) return;
  const { host, logins } = keyPicker;
  const rows = logins.length
    ? logins.map(keyPickerRowHtml).join('')
    : '<div class="kp-note">No saved login matches this site for this account yet — sign in once here and it is remembered, or import your passwords.</div>';
  $keyPicker.innerHTML = `
    <div class="kp-head">
      <span class="kp-title">Saved for ${esc(host || 'this site')} <span>· ${logins.length}</span></span>
      <button class="btn-plain" id="kp-x" title="Close" aria-label="Close">${icon('x')}</button>
    </div>
    <div class="kp-search">${icon('search')}<input id="kp-q" type="text" spellcheck="false" autocomplete="off" placeholder="Search by username or site…" aria-label="Search saved logins for this site" /></div>
    <div class="kp-body">${rows}</div>
    <div class="kp-err" id="kp-err"></div>`;
  const q = $keyPicker.querySelector('#kp-q');
  q.oninput = () => {
    const needle = q.value.trim().toLowerCase();
    $keyPicker.querySelectorAll('[data-kp-id]').forEach(r => { r.hidden = !!needle && !r.dataset.search.includes(needle); });
  };
  $keyPicker.querySelector('#kp-x').onclick = closeKeyPicker;
  $keyPicker.querySelectorAll('[data-kp-use]').forEach(b => {
    b.onclick = async () => {
      const id = b.getAttribute('data-kp-use');
      const key = keyPicker && keyPicker.key;
      closeKeyPicker(); // the banner + the page answer are the feedback for a Use
      if (key) await runLoginAction(key, id);
    };
  });
  $keyPicker.querySelectorAll('[data-kp-copy]').forEach(b => {
    b.onclick = async () => {
      const err = $keyPicker.querySelector('#kp-err');
      const key = keyPicker && keyPicker.key;
      if (!key) return;
      const r = await window.api.credsCopy(key, b.getAttribute('data-kp-copy'), b.getAttribute('data-kp-field'))
        .catch(e => ({ ok: false, message: errText(e) }));
      if (!r || !r.ok) { if (err) err.textContent = (r && r.message) || 'Could not copy that.'; return; }
      if (err) err.textContent = '';
      const was = b.textContent;
      b.textContent = 'Copied ✓';
      b.classList.add('copied');
      setTimeout(() => { b.textContent = was; b.classList.remove('copied'); }, 1400);
    };
  });
}
async function closeKeyPicker() {
  ++keyPickerRequest;
  keyPicker = null;
  $keyPicker.hidden = true;
  $keyPickerBack.hidden = true;
  $keyPicker.innerHTML = '';
  renderKeyChip();
  if (keyPickerModalOpen) {
    keyPickerModalOpen = false;
    await window.api.setModalOpen(false).catch(() => {});
  }
}
$keysite.onclick = () => { if (keyPicker) closeKeyPicker(); else openKeyPicker(); };
$keyPickerBack.addEventListener('click', closeKeyPicker);
document.getElementById('nav-back').innerHTML = icon('arrowLeft');
document.getElementById('nav-fwd').innerHTML = icon('arrowRight');
document.getElementById('nav-dash').innerHTML = icon('dashboard');
document.getElementById('nav-back').onclick = () => window.api.nav('back');
document.getElementById('nav-fwd').onclick = () => window.api.nav('forward');
document.getElementById('nav-dash').onclick = () => window.api.nav('dashboard');
document.getElementById('nav-reload').onclick = e => window.api.nav(e.currentTarget.dataset.action || 'reload');
$addr.addEventListener('focus', () => $addr.select());
$addr.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); window.api.nav('navigate', $addr.value); $addr.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renderNav(); $addr.blur(); } // restore, do NOT go Home
});
window.api.onFocusAddress(() => { if (!$nav.hidden) { $addr.focus(); $addr.select(); } });

function renderTabs() {
  $extBtn.hidden = state.activeKey === null; // only meaningful while a dashboard is open
  renderNav();
  const tabs = state.tabs.filter(tabMatchesFilter);
  if (!tabs.length) {
    $tabs.innerHTML = `<span style="color:var(--muted);font-size:12px;padding-left:4px">${
      state.tabs.length ? 'No tabs match the filter' : 'No open tabs — open an account from the left'}</span>`;
    return;
  }
  if (!state.groupTabs) { $tabs.innerHTML = tabs.map(tabHtml).join(''); return; }
  const bySvc = new Map();
  for (const t of tabs) { if (!bySvc.has(t.svc)) bySvc.set(t.svc, []); bySvc.get(t.svc).push(t); }
  $tabs.innerHTML = [...bySvc.entries()].map(([svc, list]) => {
    const s = svcOf(svc);
    const collapsed = isStripCollapsed(svc);
    return `<div class="tabgroup">
      <span class="grouplabel" data-collapse="${esc(svc)}" title="${collapsed ? 'Expand' : 'Collapse'} ${esc(s.name)} tabs">
        <span class="dot" style="background:${s.color}"></span>${esc(s.name)} ${list.length}
      </span>
      ${collapsed ? '' : list.map(tabHtml).join('')}
    </div>`;
  }).join('');
}

$tabctl.addEventListener('input', e => {
  if (e.target.id === 'filter') { filterText = e.target.value; renderTabs(); }
});
$tabctl.addEventListener('click', async e => {
  if (e.target.closest('#group-btn')) {
    state.groupTabs = await window.api.setGroupTabs(!state.groupTabs);
    renderTabCtl(); renderTabs();
  }
});
$tabs.addEventListener('click', e => {
  const close = e.target.closest('[data-close]');
  if (close) { e.stopPropagation(); window.api.closeTab(close.getAttribute('data-close')); return; }
  const coll = e.target.closest('[data-collapse]');
  if (coll) { window.api.toggleCollapsed(coll.getAttribute('data-collapse'), 'strip'); return; }
  const tabEl = e.target.closest('[data-key]');
  if (tabEl) {
    const key = tabEl.getAttribute('data-key');
    const t = state.tabs.find(x => x.key === key);
    if (t && !t.live) { const [svc, id] = key.split('::'); window.api.openAccount(svc, id); } // resume a slept tab
    else window.api.activateTab(key);
  }
});

// ============ left rail: providers > accounts + actions ============
function renderRail() {
  $railTop.innerHTML = `<button id="homebtn" class="${state.activeKey === null ? 'active' : ''}"
    title="Home — all accounts (Esc)">${icon('home')}<span>Home</span></button>`;

  $railScroll.innerHTML = services.filter(hasPresence).map(s => {
    const accs = registry.filter(a => a.svc === s.key);
    const collapsed = isCollapsed(s.key);
    const openCount = state.tabs.filter(t => t.svc === s.key).length;
    return `<div class="prov">
      <div class="provhead ${collapsed ? 'collapsed' : ''}" data-collapse="${esc(s.key)}" title="${collapsed ? 'Expand' : 'Collapse'} ${esc(s.name)}">
        <span class="chev">${icon('chevron')}</span>
        <span class="dot" style="background:${s.color}"></span>
        <span class="pname">${esc(s.name)}</span>
        <span class="count">${openCount ? `${openCount}/${accs.length}` : accs.length || ''}</span>
        <button class="provadd" data-add="${esc(s.key)}" title="Add a ${esc(s.name)} account" aria-label="Add account">${icon('plus')}</button>
        ${s.custom ? `<button class="provadd" data-rmsvc="${esc(s.key)}" title="Remove this custom service" aria-label="Remove service">${icon('x')}</button>` : ''}
      </div>
      ${collapsed ? '' : (accs.length ? accs.map(a => acctRow(a)).join('')
        : `<div class="emptyhint">No accounts yet</div>`)}
    </div>`;
  }).join('') + `${services.some(hasPresence) ? '' : '<div class="emptyhint" style="margin:8px 6px">No accounts yet — pick a service below.</div>'}
    <button class="ctlbtn" id="add-account" style="width:100%;justify-content:center;margin-top:8px"
      title="Add an account on any of the ${services.length} built-in services">${icon('plus')} Add account</button>
    <button class="ctlbtn" id="add-service" style="width:100%;justify-content:center;margin-top:6px"
      title="Add any web service by URL">${icon('plus')} Add service by URL</button>`;

  const u = updateState || {};
  const newer = ['available', 'downloading', 'downloaded'].includes(u.status);
  $railFoot.innerHTML = `
    <button class="ctlbtn" id="rail-refresh" title="Re-fetch API status for connected accounts">${icon('refresh')} Status</button>
    <button class="ctlbtn" id="rail-sleep" title="Sleep all tabs — they stay in the strip">${icon('moon')} Sleep</button>
    <button class="ctlbtn ${newer ? 'on' : ''}" id="rail-ver" title="${newer ? `Version ${esc(u.latestVersion)} is available — open the Updates panel` : 'Installed version — open the Updates panel'}">
      ${icon(newer ? 'download' : 'spark')} ${u.status === 'downloaded' ? `Restart to update ${esc(u.latestVersion)}` : newer ? `Update ${esc(u.latestVersion)}` : `v${esc(u.currentVersion || '')}`}</button>`;
}

function acctRow(a) {
  const tab = state.tabs.find(t => t.key === a.key);
  const isActive = state.activeKey === a.key;
  const badge = tab
    ? (tab.live ? '<span class="badge live">live</span>' : '<span class="badge">asleep</span>')
    : (a.lastState === 'signin' ? '<span class="badge signin">sign-in</span>' : '');
  const openAct = tab && tab.live
    ? `<button class="act" data-sleep="${esc(a.key)}" title="Sleep this tab (stays in the strip)" aria-label="Sleep tab">${icon('moon')}</button>`
    : `<button class="act" data-open="${esc(a.key)}" title="Open this account in a tab" aria-label="Open tab">${icon('play')}</button>`;
  const closeAct = tab
    ? `<button class="act" data-close="${esc(a.key)}" title="Close tab" aria-label="Close tab">${icon('x')}</button>` : '';
  const fillAct = tab && tab.live
    ? `<button class="act" data-fill="${esc(a.key)}" title="Fill this account's saved login into the page" aria-label="Fill login">${icon('key')}</button>` : '';
  // "Has saved login" indicator: visible while the row is not hovered, so a sleeping account still
  // tells you a password exists for it (0.8.0 showed nothing until a live tab was open).
  // 0.12.1: pressing this button opens this account's Manage window with its saved-login list.
  const keyBadge = a.loginCount
    ? `<button class="badge savedkey" data-gear="${esc(a.key)}" title="${a.loginCount} saved login${a.loginCount === 1 ? '' : 's'} for this account — click to see and use them" aria-label="Show saved logins">${icon('key')}</button>` : '';
  return `<div class="acct ${isActive ? 'active' : ''} ${tab ? 'open' : ''}" data-row="${esc(a.key)}" title="${esc(a.label)}">
    <span class="dot" style="background:${colorOf(a.colorIdx, a.svc)}"></span>
    <span class="aname">${esc(a.label)}</span>
    ${badge}${keyBadge}
    <span class="acts">
      ${openAct}${fillAct}${closeAct}
      <button class="act" data-connect="${esc(a.key)}" title="${a.hasToken ? 'API token connected — manage' : 'Connect an API token'}" aria-label="Connect token" style="${a.hasToken ? 'color:var(--ok)' : ''}">${icon('link')}</button>
      <button class="act" data-gear="${esc(a.key)}" title="Manage account" aria-label="Manage account">${icon('gear')}</button>
    </span>
  </div>`;
}

$railTop.addEventListener('click', async () => {
  if (state.activeKey !== null) await window.api.showHome();
});

$railFoot.addEventListener('click', async e => {
  if (e.target.closest('#rail-sleep')) { window.api.sleepAll(); return; }
  if (e.target.closest('#rail-ver')) { // jump to the Updates panel, wherever Home is scrolled to
    if (state.activeKey !== null) await window.api.showHome();
    const el = document.getElementById('updates-panel');
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
    return;
  }
  const r = e.target.closest('#rail-refresh');
  if (r) { r.disabled = true; await window.api.refreshAllStatus().catch(() => {}); r.disabled = false; }
});

$railScroll.addEventListener('click', async e => {
  if (e.target.closest('#add-service')) { openAddServiceModal(); return; }
  if (e.target.closest('#add-account')) { openPickerModal(); return; }
  const rm = e.target.closest('[data-rmsvc]');
  if (rm) {
    e.stopPropagation();
    const key = rm.getAttribute('data-rmsvc');
    if (confirm(`Remove the custom service "${svcOf(key).name}"?`)) {
      try { await window.api.removeService(key); } catch (err) { alert(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    }
    return;
  }
  const add = e.target.closest('[data-add]');
  if (add) { e.stopPropagation(); openAddModal(add.getAttribute('data-add')); return; }
  const fill = e.target.closest('[data-fill]');
  if (fill) {
    e.stopPropagation();
    await runLoginAction(fill.getAttribute('data-fill'));
    return;
  }
  const sleep = e.target.closest('[data-sleep]');
  if (sleep) { e.stopPropagation(); window.api.sleepTab(sleep.getAttribute('data-sleep')); return; }
  const close = e.target.closest('[data-close]');
  if (close) { e.stopPropagation(); window.api.closeTab(close.getAttribute('data-close')); return; }
  const conn = e.target.closest('[data-connect]');
  if (conn) { e.stopPropagation(); openEditModal(conn.getAttribute('data-connect'), true); return; }
  const gear = e.target.closest('[data-gear]');
  if (gear) { e.stopPropagation(); openEditModal(gear.getAttribute('data-gear')); return; }
  const coll = e.target.closest('[data-collapse]');
  if (coll) { window.api.toggleCollapsed(coll.getAttribute('data-collapse')); return; }
  const openBtn = e.target.closest('[data-open]');
  const row = e.target.closest('[data-row]');
  const key = openBtn ? openBtn.getAttribute('data-open') : (row ? row.getAttribute('data-row') : null);
  if (key) {
    const [svc, id] = key.split('::');
    const t = state.tabs.find(x => x.key === key);
    if (t && t.live) window.api.activateTab(key); else window.api.openAccount(svc, id);
  }
});

$hibAll.addEventListener('click', () => window.api.sleepAll());
$extBtn.innerHTML = `${icon('external')} Browser`;
$extBtn.addEventListener('click', async () => {
  const url = await window.api.activeTabUrl();
  if (url) window.api.openExternal(url);
});

// ============ home grid ============
function renderHome() {
  if (state.activeKey !== null) { $home.hidden = true; return; }
  $home.hidden = false;
  const keepScroll = $home.scrollTop; // background tab loads re-render Home; never yank the user to the top
  const editing = document.activeElement && document.activeElement.id === 'warm-limit';
  const keepValue = editing ? document.activeElement.value : null;
  const st = state.settings || {};
  $home.innerHTML = `
    <h2>Accounts</h2>
    <div class="sub">
      <span>Warm-tab limit: <input type="number" id="warm-limit" min="1" max="15" value="${state.warmLimit}"></span>
      <button class="ctlbtn" id="refresh-status" title="Re-fetch API status for all connected accounts">${icon('refresh')} Refresh status</button>
      <button class="ctlbtn ${st.adBlock ? 'on' : ''}" id="t-adBlock" title="Block ads and trackers in account tabs (uBlock-style, built in). Applies to every account that follows the app-wide setting — an account can override it in its gear window">${icon('shield')} Ad-block${state.blocked ? ` · ${state.blocked}` : ''}</button>
      <button class="ctlbtn ${st.darkMode ? 'on' : ''}" id="t-darkMode" title="Dark mode for every account tab, powered by Dark Reader — applies instantly, no reload. Accounts that follow the app-wide setting switch with it; per-account overrides in the gear window win">${icon('moon')} Dark mode</button>
      <span>· click a card to open its dashboard — sessions persist per account</span>
    </div>
    ${services.filter(hasPresence).map(svc => {
      const accs = registry.filter(a => a.svc === svc.key);
      return `<div class="svcgroup">
        <div class="head">
          <span class="dot" style="background:${svc.color}"></span>
          <span class="name">${esc(svc.name)}</span>
          ${POLICY_TEXT[svc.multiAccountPolicy] ? `<span class="policy">${esc(POLICY_TEXT[svc.multiAccountPolicy])}</span>` : ''}
        </div>
        <div class="cards">
          ${accs.map(a => cardHtml(svc, a)).join('')}
          <div class="card addcard" data-add2="${esc(svc.key)}" title="Add a ${esc(svc.name)} account">${icon('plus')} Add account</div>
        </div>
      </div>`;
    }).join('')}
    ${storeNoticeHtml()}
    ${pickerHtml('data-add2')}
    ${updatePanel()}
    <div class="svcgroup">
      <div class="head"><span class="name">Saved logins</span>
        <span class="policy">${(state.credCount != null ? state.credCount : (credStats ? credStats.total : 0))} stored · encrypted with AES-256-GCM, survives restarts</span></div>
      <div class="sub" style="margin-bottom:0">
        <button class="ctlbtn ${st.saveLogins ? 'on' : ''}" id="t-saveLogins" title="Remember logins you type in account tabs">${icon('key')} Remember logins</button>
        <button class="ctlbtn ${st.autofill ? 'on' : ''}" id="t-autofill" title="Fill the saved login automatically when a sign-in page appears">${icon('play')} Auto-fill</button>
        <button class="ctlbtn" id="imp-browser" title="Import saved passwords from an installed browser">${icon('download')} Import from browser</button>
        <button class="ctlbtn" id="imp-csv" title="Import a password CSV exported from any browser">${icon('download')} Import CSV</button>
        ${(state.credCount || (credStats && credStats.total)) ? `<button class="ctlbtn" id="imp-manage" title="See, choose and delete saved logins per site">${icon('gear')} Manage logins…</button><button class="ctlbtn" id="imp-clear" title="Delete every stored login">${icon('x')} Clear</button>` : ''}
      </div>
    </div>`;
  restoreHomeFocus(keepValue); // re-renders no longer kick you out of the warm-limit field
  $home.scrollTop = keepScroll;
}

// The one honest notice about the saved-login store (0.13.0). It is drawn ONLY when main reports it:
// either an old-format store this machine cannot read (re-import once — D35), or a current store that
// failed its integrity check. Dismissing it hides it for this launch only; it returns at the next
// start while the condition is still true, so it can never silently disappear and look like "fine".
function storeNoticeHtml() {
  const n = credStoreState || {};
  if (n.notice && !storeNoticeDismissed) {
    return `<div class="storenotice" id="store-notice" role="status">
      <span class="ic">${icon('key')}</span>
      <span class="msg">${esc(n.notice)}</span>
      <span class="acts"><button class="btn-plain" id="store-notice-x" title="Hide until the next start">${icon('x')}</button></span>
    </div>`;
  }
  if (n.error && !storeNoticeDismissed) {
    return `<div class="storenotice bad" id="store-notice" role="alert">
      <span class="ic">${icon('key')}</span>
      <span class="msg">Saved logins could not be read: ${esc(n.error.message)}. The file was left untouched.</span>
      <span class="acts"><button class="btn-plain" id="store-notice-x" title="Hide until the next start">${icon('x')}</button></span>
    </div>`;
  }
  return '';
}

function refreshCredStoreState() {
  return window.api.credsStoreState().then(s => { credStoreState = s || { notice: null, error: null }; }).catch(() => {});
}

// After anything that can change the store's FORMAT (an import re-encrypts to v2, Clear removes it),
// re-read both numbers and the notice together, so the honest banner disappears the moment a
// re-import has seeded the new store — and never before.
async function refreshCreds() {
  credStats = await window.api.credsStats().catch(() => credStats);
  await refreshCredStoreState();
}


// Chips for every service that has no presence yet, grouped by category. `attr` is the data attribute
// the click handler listens for. `all` lists every service (the modal picker), `q` filters by name.
function pickerHtml(attr, all = false, q = '') {
  const needle = q.trim().toLowerCase();
  const pool = services.filter(s => (all || !hasPresence(s)) && (!needle || s.name.toLowerCase().includes(needle) || s.key.includes(needle)));
  if (!pool.length) return all ? '<div class="emptyhint">No service matches.</div>' : '';
  const groups = CATEGORIES.map(([k, label]) => [label, pool.filter(s => categoryOf(s) === k)]).filter(([, list]) => list.length);
  return `<div class="svcgroup picker">
    ${all ? '' : `<div class="head"><span class="name">Add an account</span><span class="policy">${pool.length} services built in — or add any site by URL</span></div>`}
    ${groups.map(([label, list]) => `<div class="pickgroup"><div class="picklabel">${esc(label)}</div><div class="chips">
      ${list.map(s => `<button class="chip" ${attr}="${esc(s.key)}" title="Add a ${esc(s.name)} account"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</button>`).join('')}
    </div></div>`).join('')}
  </div>`;
}

function openPickerModal() {
  const render = q => {
    $modal.innerHTML = `
      <h3>Add account</h3>
      <input type="text" id="pick-q" placeholder="Search ${services.length} services…" value="${esc(q)}" />
      <div class="pickscroll">${pickerHtml('data-pick', true, q)}</div>
      <div class="row"><button class="btn-plain" id="m-cancel">Cancel</button></div>`;
    const input = $modal.querySelector('#pick-q');
    input.oninput = () => { const v = input.value; const at = input.selectionStart; render(v); const i2 = $modal.querySelector('#pick-q'); i2.focus(); i2.setSelectionRange(at, at); };
    $modal.querySelector('#m-cancel').onclick = closeModal;
    $modal.querySelectorAll('[data-pick]').forEach(b => { b.onclick = () => openAddModal(b.getAttribute('data-pick')); });
  };
  render('');
  $modalBack.hidden = false;
  window.api.setModalOpen(true);
  $modal.querySelector('#pick-q').focus();
}

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function updatePanel() {
  const u = updateState || {};
  const cur = u.currentVersion || '';
  let line = '';
  let buttons = `<button class="ctlbtn" id="upd-check" title="Check GitHub for a newer release">${icon('refresh')} Check for updates</button>`;

  if (u.status === 'checking') line = 'Checking for updates…';
  else if (u.status === 'up-to-date') line = `<span class="ok">You are on the latest version.</span>${u.lastChecked ? ` Checked ${new Date(u.lastChecked).toLocaleTimeString()}.` : ''}`;
  else if (u.status === 'available') {
    line = `<span class="warn">Version ${esc(u.latestVersion)} is available.</span>`;
    buttons += u.canDownload
      ? `<button class="ctlbtn on" id="upd-download" title="Download this update now">${icon('download')} Download ${esc(u.latestVersion)}</button>`
      : `<button class="ctlbtn" id="upd-open" title="Open the release page">${icon('external')} View release</button>`;
  } else if (u.status === 'downloading') {
    const p = u.progress || {};
    line = `Downloading ${esc(u.latestVersion || '')}… ${p.percent != null ? p.percent + '%' : ''} ${p.total ? `(${fmtBytes(p.transferred)} of ${fmtBytes(p.total)})` : ''}`;
    buttons = '';
  } else if (u.status === 'downloaded') {
    line = `<span class="ok">Version ${esc(u.latestVersion)} is downloaded.</span> It installs silently when you close the app — or restart now.`;
    buttons = `<button class="ctlbtn on" id="upd-install" title="Restart now and install the update silently (no installer wizard)">${icon('spark')} Restart &amp; update</button>`;
  } else if (u.status === 'error') {
    line = `<span class="warn">${esc(u.error || 'Update check failed.')}</span>`;
    buttons += `<button class="ctlbtn" id="upd-token" title="Store a GitHub token so the app can read the private repository's releases">${icon('key')} ${u.hasToken ? 'Replace token' : 'Add token'}</button>`;
  } else if (u.status === 'unsupported') {
    line = `<span class="warn">${esc(u.error || 'Updates are not available in this build.')}</span>`;
  }

  const notes = (u.status === 'available' || u.status === 'downloaded') && u.releaseNotes
    ? `<div style="margin-top:8px;padding:10px;background:var(--panel);border:1px solid var(--border);border-radius:8px;max-height:150px;overflow:auto;white-space:pre-wrap;font-size:11px;line-height:1.55;color:var(--muted)">${esc(u.releaseNotes)}</div>`
    : '';
  const autoBtn = `<button class="ctlbtn ${u.autoUpdate !== false ? 'on' : ''}" id="t-autoUpdate" title="${u.autoUpdate !== false ? 'Auto-update is on: new releases download in the background and install silently when the app closes' : 'Auto-update is off: nothing is downloaded or installed until you press the buttons'}">${icon('refresh')} Auto-update</button>`;
  const devNote = u.packaged === false
    ? '<div style="color:var(--muted);font-size:11px;margin-top:6px">Running from source: version checks work, but installing an update needs the packaged app.</div>'
    : '';

  return `<div class="svcgroup" id="updates-panel">
    <div class="head"><span class="name">Updates</span>
      <span class="policy">version ${esc(cur)}${u.latestVersion && u.latestVersion !== cur ? ` · latest ${esc(u.latestVersion)}` : ''}</span></div>
    <div class="sub" style="margin-bottom:0">${autoBtn}${buttons}<span>${line}</span></div>
    ${notes}${devNote}
  </div>`;
}

function cardHtml(svc, a) {
  const st = a.status;
  let statusText = '';
  if (a.hasToken && st && st.summary) {
    const names = st.summary.names && st.summary.names.filter(Boolean).length
      ? ` · ${esc(st.summary.names.filter(Boolean).join(', '))}` : '';
    const sm = st.summary;
    const parts = [];
    if (sm.user) parts.push(`<span class="ok">${esc(String(sm.user))}</span>`);
    if (typeof sm.projects === 'number') parts.push(`<span class="ok">${sm.projects} projects</span>${names}`);
    if (typeof sm.charges === 'boolean') parts.push(`${sm.live ? 'live' : 'test'} · charges ${sm.charges ? 'on' : 'off'} · payouts ${sm.payouts ? 'on' : 'off'}`);
    statusText = parts.length ? parts.join(' · ') : '<span class="ok">connected</span>';
    if (sm.latest) statusText += ` · last deploy ${esc(String(sm.latest.state || ''))}`;
  } else if (a.hasToken && st && st.error) {
    statusText = `<span class="warn">API: ${esc(st.error)}</span>`;
  } else if (a.hasToken && !st) {
    statusText = 'checking…';
  }
  const tab = state.tabs.find(t => t.key === a.key);
  const openState = tab ? (tab.live ? '<span class="ok">open</span>' : 'asleep') : '';
  const signState = a.lastState === 'signin' ? '<span class="warn">sign-in needed</span>' : (a.lastState === 'ok' ? 'signed in' : '');
  // 0.11.0: a minimal marker so an exception is visible without opening each gear window.
  const ov = a.contentOverridden || {};
  const custom = ov.adBlock || ov.darkMode
    ? `<span class="contentcustom" title="This account overrides the app-wide ad-block / dark-mode settings — open its gear window to see or reset them">content: custom${ov.adBlock && ov.darkMode ? '' : ov.adBlock ? ' (ad-block)' : ' (dark mode)'}</span>`
    : '';
  const meta = [openState, signState, statusText, custom].filter(Boolean).join(' · ');
  return `<div class="card" data-open="${esc(a.key)}" title="Open ${esc(svc.name)} / ${esc(a.label)}">
    <div class="top">
      <span class="dot" style="background:${colorOf(a.colorIdx, a.svc)}"></span>
      <span class="label">${esc(a.label)}</span>
      <button class="gear" data-gear="${esc(a.key)}" title="Manage account" aria-label="Manage account">${icon('gear')}</button>
    </div>
    <div class="meta">${meta}</div>
  </div>`;
}

function restoreHomeFocus(keepValue) {
  if (keepValue === null) return;
  const el = document.getElementById('warm-limit');
  if (el) { el.value = keepValue; el.focus(); }
}

$home.addEventListener('change', async e => {
  if (e.target && e.target.id === 'warm-limit') {
    state.warmLimit = await window.api.setWarmLimit(Number(e.target.value));
    renderHome();
  }
});

$home.addEventListener('click', async e => {
  const noticeX = e.target.closest('#store-notice-x');
  if (noticeX) { storeNoticeDismissed = true; renderHome(); return; }
  const refresh = e.target.closest('#refresh-status');
  if (refresh) { refresh.disabled = true; await window.api.refreshAllStatus().catch(() => {}); refresh.disabled = false; return; }
  const autoBtn = e.target.closest('#t-autoUpdate');
  if (autoBtn) {
    const cur = !(updateState && updateState.autoUpdate === false);
    window.api.setContentSetting('autoUpdate', !cur).then(v => { updateState = Object.assign({}, updateState, { autoUpdate: v }); renderHome(); }).catch(() => {});
    return;
  }
  const updBtn = e.target.closest('#upd-check, #upd-download, #upd-install, #upd-open, #upd-token');
  if (updBtn) {
    try {
      if (updBtn.id === 'upd-check') { updBtn.disabled = true; updateState = await window.api.updateCheck(); renderHome(); }
      else if (updBtn.id === 'upd-download') { await window.api.updateDownload(); }
      else if (updBtn.id === 'upd-install') { await window.api.updateInstall(); }
      else if (updBtn.id === 'upd-open' && updateState.releaseUrl) { window.api.openExternal(updateState.releaseUrl); }
      else if (updBtn.id === 'upd-token') { openUpdateTokenModal(); }
    } catch (err) {
      alert(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      renderHome();
    }
    return;
  }
  if (e.target.closest('#imp-browser')) { openImportModal(); return; }
  if (e.target.closest('#imp-csv')) {
    try {
      const r = await window.api.credsImportCsv();
      if (r) { await refreshCreds(); renderHome(); alert(`Imported ${r.added} new logins${r.updated ? `, updated ${r.updated}` : ''} (${r.found} found, ${credStats ? credStats.total : 0} stored).`); }
    } catch (err) { alert(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    return;
  }
  if (e.target.closest('#imp-manage')) { openCredsManagerModal(); return; }
  if (e.target.closest('#imp-clear')) {
    if (confirm('Delete every stored login? Sessions stay signed in; only saved passwords are removed.')) {
      await window.api.credsClear();
      await refreshCreds();
      renderHome();
    }
    return;
  }
  const toggle = e.target.closest('[id^="t-"]');
  if (toggle) {
    const name = toggle.id.slice(2);
    const cur = (state.settings || {})[name];
    state.settings = Object.assign({}, state.settings, { [name]: await window.api.setContentSetting(name, !cur) });
    renderHome();
    return;
  }
  const gear = e.target.closest('[data-gear]');
  if (gear) { e.stopPropagation(); openEditModal(gear.getAttribute('data-gear')); return; }
  const add = e.target.closest('[data-add2]');
  if (add) { openAddModal(add.getAttribute('data-add2')); return; }
  const card = e.target.closest('[data-open]');
  if (card) { const [svc, id] = card.getAttribute('data-open').split('::'); window.api.openAccount(svc, id); }
});

// ============ modals ============
function openAddModal(svc) {
  const service = svcOf(svc);
  const existing = registry.filter(a => a.svc === svc).length;
  const policy = POLICY_TEXT[service.multiAccountPolicy];
  $modal.innerHTML = `
    <h3>Add ${esc(service.name)} account</h3>
    <label>Account name</label>
    <input type="text" id="m-label" value="acc${existing + 1}" />
    <div class="row"><button class="btn-primary" id="m-login">I have an account — Log in</button></div>
    <div class="row"><button class="btn-plain" id="m-signup">Create a new account (guided)</button></div>
    <div id="m-error" style="color:var(--danger);font-size:11px;margin-top:8px"></div>
    <div class="note">${policy
      ? `${esc(policy)}. Signup is manual inside this account's own isolated session — never automated.`
      : (service.category === 'google'
        ? 'The session opens inside this account’s own isolated browser storage. Google sign-in works here directly; if Google ever refuses the browser, use “Open in system browser”.'
        : 'The session opens inside this account’s own isolated browser storage. “Continue with Google” on third-party sites is blocked in embedded browsers — use email/password or GitHub there.')}</div>
    <div class="row"><button class="btn-plain" id="m-cancel">Cancel</button></div>`;
  $modalBack.hidden = false;
  window.api.setModalOpen(true);
  $modal.querySelector('#m-cancel').onclick = closeModal;
  $modal.querySelector('#m-login').onclick = () => doAdd(svc, 'login');
  $modal.querySelector('#m-signup').onclick = () => doAdd(svc, 'signup');
  $modal.querySelector('#m-label').focus();
}

async function doAdd(svc, mode) {
  const label = $modal.querySelector('#m-label').value.trim() || `acc${registry.length + 1}`;
  try {
    await window.api.addAccount(svc, { id: label.toLowerCase(), label, mode });
    closeModal();
  } catch (err) {
    const box = $modal.querySelector('#m-error');
    if (box) box.textContent = `Failed to add account: ${String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
}

async function openImportModal() {
  $modal.innerHTML = `<h3>Import passwords from a browser</h3><div class="note">Scanning…</div>`;
  $modalBack.hidden = false;
  window.api.setModalOpen(true);
  let list = [];
  try { list = await window.api.credsBrowsers(); } catch {}
  $modal.innerHTML = `
    <h3>Import passwords from a browser</h3>
    ${list.length ? list.map((b, i) => `
      <div class="row"><button class="btn-plain" data-imp="${i}" style="text-align:left">${esc(b.browser)} — ${esc(b.profile)}</button></div>`).join('')
      : '<div class="note">No Chrome, Edge, Brave, Vivaldi, Opera or Firefox profile with saved passwords was found.</div>'}
    <div id="m-error" style="font-size:11px;margin-top:10px;line-height:1.5"></div>
    <div class="row"><button class="btn-plain" id="m-cancel">Close</button></div>
    <div class="note">Close the browser first so its password database is readable. Chrome 127+ can lock entries with app-bound encryption — those must be exported to CSV from the browser instead (Settings → Passwords → Export). Firefox profiles are read directly, but a profile with a <b>master password</b> set, or one from Firefox 62 or earlier, must be exported to CSV from Firefox instead.</div>`;
  $modal.querySelector('#m-cancel').onclick = closeModal;
  $modal.querySelectorAll('[data-imp]').forEach(btn => {
    btn.onclick = async () => {
      const b = list[Number(btn.getAttribute('data-imp'))];
      const box = $modal.querySelector('#m-error');
      box.style.color = 'var(--muted)';
      box.textContent = 'Importing…';
      try {
        const r = b.kind === 'firefox'
          ? await window.api.credsImportFirefox(b.id)
          : await window.api.credsImportBrowser(b.id);
        await refreshCreds();
        // A refused profile (master password / old format / damaged) is a result, not a crash: say
        // exactly what is wrong and what to do instead, and never look like a successful empty import.
        if (r.refused) {
          box.style.color = 'var(--danger)';
          box.textContent = r.note || 'This profile could not be imported.';
        } else {
          box.style.color = r.added ? 'var(--ok)' : 'var(--warn)';
          const scanned = r.scanned != null ? r.scanned : r.found + r.locked + r.failed;
          box.textContent = `${r.added} new logins imported${r.updated ? `, ${r.updated} updated` : ''} (${r.found} readable of ${scanned}).` + (r.note ? ` ${r.note}` : '');
        }
        renderHome();
      } catch (err) {
        box.style.color = 'var(--danger)';
        box.textContent = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      }
    };
  });
}

function openUpdateTokenModal() {
  $modal.innerHTML = `
    <h3>GitHub token for updates</h3>
    <div class="note" style="margin-top:0">The release repository is private, so reading its releases needs a token.
      Create a fine-grained token with <b>read access to this repository's contents</b> and paste it here — it is
      encrypted with Windows DPAPI and used only to check for and download updates. Making the repository public
      removes the need for a token entirely.</div>
    <label>Token</label>
    <input type="password" id="u-token" placeholder="github_pat_… or ghp_…" />
    <div id="m-error" style="font-size:11px;margin-top:8px"></div>
    <div class="row">
      <button class="btn-primary" id="u-save">Save &amp; check</button>
      <button class="btn-plain" id="m-cancel">Cancel</button>
    </div>
    ${updateState.hasToken ? '<div class="row"><button class="btn-plain" id="u-clear">Remove stored token</button></div>' : ''}`;
  $modalBack.hidden = false;
  window.api.setModalOpen(true);
  $modal.querySelector('#m-cancel').onclick = closeModal;
  const box = $modal.querySelector('#m-error');
  $modal.querySelector('#u-save').onclick = async () => {
    const val = $modal.querySelector('#u-token').value.trim();
    if (!val) { box.style.color = 'var(--danger)'; box.textContent = 'Paste a token first.'; return; }
    box.style.color = 'var(--muted)'; box.textContent = 'Saving and checking…';
    try {
      updateState = await window.api.updateSetToken(val);
      closeModal(); renderHome();
    } catch (err) {
      box.style.color = 'var(--danger)';
      box.textContent = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
  const clear = $modal.querySelector('#u-clear');
  if (clear) clear.onclick = async () => { updateState = await window.api.updateSetToken(''); closeModal(); renderHome(); };
  $modal.querySelector('#u-token').focus();
}

function openAddServiceModal() {
  $modal.innerHTML = `
    <h3>Add a service</h3>
    <label>Name</label>
    <input type="text" id="s-name" placeholder="e.g. Fly.io" />
    <label>Dashboard or login URL</label>
    <input type="text" id="s-url" placeholder="https://fly.io/dashboard" />
    <div id="m-error" style="color:var(--danger);font-size:11px;margin-top:8px"></div>
    <div class="row"><button class="btn-primary" id="s-add">Add service</button><button class="btn-plain" id="m-cancel">Cancel</button></div>
    <div class="row"><button class="btn-plain" id="s-plugins">Service plugins…</button></div>
    <div class="note">Any web service works — it gets its own row in the rail, and each account you add under it gets a fully isolated, persistent session just like the built-in providers.</div>`;
  $modalBack.hidden = false;
  window.api.setModalOpen(true);
  $modal.querySelector('#m-cancel').onclick = closeModal;
  $modal.querySelector('#s-add').onclick = async () => {
    const box = $modal.querySelector('#m-error');
    try {
      await window.api.addService({ name: $modal.querySelector('#s-name').value, url: $modal.querySelector('#s-url').value });
      closeModal();
    } catch (err) {
      box.textContent = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
  $modal.querySelector('#s-plugins').onclick = () => openPluginsModal();
  $modal.querySelector('#s-name').focus();
}

async function openPluginsModal() {
  $modalBack.hidden = false;
  window.api.setModalOpen(true);
  const info = await window.api.pluginsList().catch(() => ({ services: [], errors: [], dir: '' }));
  $modal.innerHTML = `
    <h3>Service plugins</h3>
    ${info.services.length ? info.services.map(p => `
      <div class="row" style="align-items:center">
        <span style="flex:1">${esc(p.name)} <span style="color:var(--muted);font-size:11px">${esc(p.key)}${p.hasApi ? ' · API' : ''}</span></span>
        <button class="btn-plain" data-rmplug="${esc(p.key)}" style="flex:none">Remove</button>
      </div>`).join('') : '<div class="note">No plugins installed yet.</div>'}
    ${info.errors && info.errors.length ? `<div style="color:var(--danger);font-size:11px;margin-top:8px">${
      info.errors.map(e => `${esc(e.file)}: ${esc(e.error)}`).join('<br>')}</div>` : ''}
    <div id="m-error" style="font-size:11px;margin-top:8px"></div>
    <div class="row">
      <button class="btn-primary" id="p-install">Install manifest…</button>
      <button class="btn-plain" id="p-example">Example</button>
    </div>
    <div class="row"><button class="btn-plain" id="m-cancel">Close</button></div>
    <div class="note">A plugin is a small JSON file describing a service (URLs, colour, policy) and
      optionally how to read its API for status cards. Drop files in <code>${esc(info.dir || 'plugins')}</code>
      or install one here. "Example" writes a documented sample next to them.</div>`;
  $modal.querySelector('#m-cancel').onclick = closeModal;
  $modal.querySelector('#p-install').onclick = async () => {
    const box = $modal.querySelector('#m-error');
    try {
      const svc = await window.api.pluginInstall();
      if (svc) { box.style.color = 'var(--ok)'; box.textContent = `Installed ${svc.name}.`; openPluginsModal(); }
    } catch (err) {
      box.style.color = 'var(--danger)';
      box.textContent = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
  $modal.querySelector('#p-example').onclick = () => window.api.pluginWriteExample();
  $modal.querySelectorAll('[data-rmplug]').forEach(b => {
    b.onclick = async () => {
      const box = $modal.querySelector('#m-error');
      try { await window.api.pluginRemove(b.getAttribute('data-rmplug')); openPluginsModal(); }
      catch (err) { box.style.color = 'var(--danger)'; box.textContent = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    };
  });
}

// ---------- per-account content settings (0.11.0) ----------
// The raw override lives on the account record main sends (`contentOverride`), sparse: only keys the
// user changed exist. 'follow' is the ABSENT key; main deletes on clear, so the renderer never has to
// model "unset" separately.
function overrideValue(acc, name) {
  const v = acc && acc.contentOverride ? acc.contentOverride[name] : undefined;
  return v === 'on' || v === 'off' ? v : 'follow';
}
function contentOptions(acc, name) {
  const cur = overrideValue(acc, name);
  return [['follow', 'Follow the app-wide setting'], ['on', 'Always on for this account'], ['off', 'Always off for this account']]
    .map(([v, label]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`).join('');
}
// The sentence under the select: where the value comes from, and what it currently means.
function contentStateText(acc, name) {
  const globalOn = !!(state.settings || {})[name];
  const v = overrideValue(acc, name);
  if (v === 'on') return 'Always on for this account — the app-wide toggle is ignored here.';
  if (v === 'off') return 'Always off for this account — the app-wide toggle is ignored here.';
  return `Following the app-wide setting — currently ${globalOn ? 'on' : 'off'}.`;
}
// Update the modal's local copy of the sparse override from main's authoritative answer.
function mergeOverride(prev, name, value) {
  const next = Object.assign({}, prev || {});
  if (value === 'follow') { delete next[name]; return Object.keys(next).length ? next : null; }
  next[name] = value;
  return next;
}

function openEditModal(key, focusToken = false) {
  const [svc, id] = key.split('::');
  const acc = registry.find(a => a.svc === svc && a.id === id);
  if (!acc) return;
  $modal.innerHTML = `
    <h3>${esc(svcOf(svc).name)} · ${esc(acc.label)}</h3>
    <label>Display name</label>
    <input type="text" id="m-label" value="${esc(acc.label)}" />
    <label>API token (read-only scope recommended — encrypted with Windows DPAPI, sent only to this service's API)</label>
    <input type="password" id="m-token" placeholder="${acc.hasToken ? 'token stored — paste to replace' : esc(svcOf(svc).tokenHint || 'paste token to connect')}" />
    <div class="row">
      <button class="btn-plain" id="m-token-save">Validate &amp; save token</button>
      ${acc.hasToken ? '<button class="btn-plain" id="m-token-clear">Remove token</button>' : ''}
    </div>
    <label>Proxy (optional — http://host:port or socks5://host:port)</label>
    <input type="text" id="m-proxy" value="${esc(acc.proxy || '')}" placeholder="system default" />
    <label>Saved logins for this account</label>
    <div class="acctlogins" id="m-logins"><div class="acctlogin empty">Loading…</div></div>
    <label class="switcher" style="display:block">
      <span style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="m-noauto" ${acc.noAutoFill ? 'checked' : ''} />
        <span>Never auto-fill for this account</span>
      </span>
    </label>
    <div class="note" style="margin-top:4px">Auto-fill still needs the app-wide <b>Auto-fill</b> toggle on Home; this switch only stops it for this account. Manual <b>Use</b> and the rail key always work.</div>
    <label>Content settings for this account</label>
    <div class="contentctl">
      <label for="m-content-adBlock">Ad-block</label>
      <select id="m-content-adBlock">${contentOptions(acc, 'adBlock')}</select>
      <div class="note" id="m-content-adBlock-state">${esc(contentStateText(acc, 'adBlock'))}</div>
      <label for="m-content-darkMode">Dark mode</label>
      <select id="m-content-darkMode">${contentOptions(acc, 'darkMode')}</select>
      <div class="note" id="m-content-darkMode-state">${esc(contentStateText(acc, 'darkMode'))}</div>
    </div>
    <div class="note">Overrides replace the app-wide toggle for this account, in both directions — an account can be blocked or dark while the app-wide toggle is off, and vice versa. Changing one applies at once to this account's open tab; turning ad-block <b>off</b> reloads that tab (the hidden-ad style can only be removed by reloading).</div>
    <div class="row"><button class="btn-primary" id="m-save">Save</button><button class="btn-plain" id="m-cancel">Cancel</button></div>
    <div class="row"><button class="btn-danger" id="m-del" title="Deletes this account's stored session">Delete account &amp; wipe session</button></div>
    <div id="m-error" style="font-size:11px;margin-top:8px"></div>
    <div class="note">Renaming changes only the label — the stored session stays bound to this account. Deleting is irreversible. Netlify tokens are necessarily full-scope (no read-only tier exists).</div>`;
  $modalBack.hidden = false;
  window.api.setModalOpen(true);
  $modal.querySelector('#m-cancel').onclick = closeModal;
  const saveBtn = $modal.querySelector('#m-save');
  const labelInput = $modal.querySelector('#m-label');
  const syncSave = () => { saveBtn.disabled = !labelInput.value.trim(); };
  labelInput.addEventListener('input', syncSave);
  syncSave();
  const box = $modal.querySelector('#m-error');
  $modal.querySelector('#m-token-save').onclick = async () => {
    const plain = $modal.querySelector('#m-token').value.trim();
    if (!plain) { box.style.color = 'var(--danger)'; box.textContent = 'Paste a token first.'; return; }
    box.style.color = 'var(--muted)';
    box.textContent = 'Validating with the service…';
    try {
      await window.api.setAccountToken(svc, id, plain);
      box.style.color = 'var(--ok)';
      box.textContent = 'Token validated and stored — status will update.';
      setTimeout(closeModal, 800);
    } catch (err) {
      box.style.color = 'var(--danger)';
      box.textContent = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
  const clearBtn = $modal.querySelector('#m-token-clear');
  if (clearBtn) clearBtn.onclick = async () => { await window.api.clearAccountToken(svc, id); closeModal(); };
  // The per-account Logins list: exactly the logins that match this account, each with Use.
  renderAccountLogins(key, $modal.querySelector('#m-logins'), $modal.querySelector('#m-error'));
  // "Never auto-fill" is saved on change (not on Save): it is a standing preference, not a form field.
  const noAuto = $modal.querySelector('#m-noauto');
  noAuto.onchange = async () => {
    try { noAuto.checked = await window.api.accountNoAutoFill(svc, id, noAuto.checked); }
    catch (err) { const b2 = $modal.querySelector('#m-error'); b2.style.color = 'var(--danger)'; b2.textContent = errText(err); }
  };
  // Content settings are saved on change too (a standing preference, like Never auto-fill). The
  // worded state under each select is re-rendered from MAIN's answer, so the sentence always
  // describes what the account actually resolves to now.
  for (const name of ['adBlock', 'darkMode']) {
    const sel = $modal.querySelector(`#m-content-${name}`);
    if (!sel) continue;
    sel.onchange = async () => {
      try {
        const r = await window.api.accountContentOverride(svc, id, name, sel.value);
        const fresh = registry.find(a => a.svc === svc && a.id === id) || acc;
        fresh.contentOverride = mergeOverride(acc.contentOverride, name, r.value);
        const stateLine = $modal.querySelector(`#m-content-${name}-state`);
        if (stateLine) stateLine.textContent = contentStateText(fresh, name);
      } catch (err) { const b2 = $modal.querySelector('#m-error'); b2.style.color = 'var(--danger)'; b2.textContent = errText(err); }
    };
  }
  saveBtn.onclick = async () => {
    await window.api.updateAccount(svc, id, { label: labelInput.value, proxy: $modal.querySelector('#m-proxy').value });
    closeModal();
  };
  $modal.querySelector('#m-del').onclick = async () => {
    if (confirm(`Delete ${svcOf(svc).name} / ${acc.label} and wipe its stored session? This cannot be undone.`)) {
      await window.api.deleteAccount(svc, id);
      closeModal();
    }
  };
  ($modal.querySelector(focusToken ? '#m-token' : '#m-label')).focus();
}

// ============ saved logins: manager, per-account list, chooser, notices ============
// Passwords never reach this renderer: every row is a summary (id/host/username/source/★). Main owns
// the list, the ★ markers and the resolution; the renderer only renders what it is given.
function errText(err) { return String(err && err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }

// One entry point for every "use this saved login" click: the rail key, a manager row, a gear row.
// Main answers either { ok: true } or a reason we can show instead of a dead-end alert.
async function runLoginAction(key, credentialId) {
  let r = null;
  try { r = await window.api.fillLogin(key, credentialId || null); }
  catch (err) { showNotice(key, { kind: 'failed', reason: errText(err) }); return; }
  if (r && r.choose) { openCredsChooser(key, r.choose); return; }
  if (r && r.ok) return;
  showNotice(key, { kind: 'failed', reason: (r && r.message) || 'Could not fill this login.' });
}

// ---------- the auto-fill notice (a strip above the account view) ----------
// Main sends it because the decision (fill / choose / failed) is main's; the banner can be dismissed,
// undone, or used to pick among several logins. It never shows a password.
let noticeState = null; // { key, notice }
function renderInfobar() {
  const n = noticeState && noticeState.notice;
  const key = noticeState && noticeState.key;
  if (!n || state.activeKey !== key) { $infobar.hidden = true; $infobar.innerHTML = ''; return; }
  $infobar.hidden = false;
  if (n.kind === 'choose') {
    $infobar.innerHTML = `<span class="ic">${icon('key')}</span>
      <span class="msg">More than one saved login matches this site. Pick one:</span>
      <span class="chips">${n.choices.map(c => `<button data-notice-pick="${esc(c.id)}" title="${esc(c.host)} · ${esc(c.source)}">${esc(c.username || '(no username)')} <span class="who">· ${esc(c.source)}</span></button>`).join('')}</span>
      <span class="acts"><button class="btn-plain" id="notice-x" title="Dismiss">${icon('x')}</button></span>`;
    $infobar.querySelectorAll('[data-notice-pick]').forEach(b => {
      b.onclick = async () => {
        const r = await window.api.noticeChoose(key, b.getAttribute('data-notice-pick')).catch(err => ({ ok: false, reason: errText(err) }));
        if (!r.ok) showNotice(key, { kind: 'failed', reason: 'Could not fill that login on this page.' });
      };
    });
  } else if (n.kind === 'filled') {
    $infobar.innerHTML = `<span class="ic">${icon('key')}</span>
      <span class="msg">Filled <b>${esc(n.username || 'your saved login')}</b> into this page.</span>
      <span class="acts">
        <button class="btn-plain" id="notice-undo">Undo</button>
        <button class="btn-plain" id="notice-x" title="Dismiss" aria-label="Dismiss">${icon('x')}</button>
      </span>`;
    $infobar.querySelector('#notice-undo').onclick = async () => {
      const r = await window.api.undoFill(key).catch(err => ({ ok: false, reason: errText(err) }));
      if (!r.ok) showNotice(key, { kind: 'failed', reason: r.reason === 'nothing-filled' ? 'Those fields are no longer on this page.' : 'Could not clear the filled fields.' });
    };
  } else {
    $infobar.innerHTML = `<span class="ic">${icon('key')}</span>
      <span class="msg">Login not filled — <span class="why">${esc(n.reason || 'no visible sign-in form on this page')}</span>.</span>
      <span class="acts"><button class="btn-plain" id="notice-x" title="Dismiss" aria-label="Dismiss">${icon('x')}</button></span>`;
  }
  const x = $infobar.querySelector('#notice-x');
  if (x) x.onclick = () => { window.api.dismissNotice(key); noticeState = null; renderInfobar(); };
}
function showNotice(key, notice) { noticeState = { key, notice }; renderInfobar(); }

// ---------- per-account Logins list (gear / Manage modal) ----------
async function renderAccountLogins(key, container, box) {
  const [svc, id] = key.split('::');
  let data = { logins: [] };
  try { data = await window.api.credsAccountList(svc, id); } catch {}
  const logins = data.logins || [];
  const tab = state.tabs.find(t => t.key === key && t.live);
  container.innerHTML = logins.length
    ? logins.map(l => `<div class="acctlogin">
        <span class="who">${esc(l.username || '(no username)')}${l.isDefault ? ' <span class="star" title="This account’s default — auto-fill uses it first">★</span>' : ''}</span>
        <span class="acts"><button class="btn-plain" data-uselogin="${esc(l.id)}" title="${tab ? 'Set as this account’s default and fill it into the open tab' : 'Set as this account’s default — the tab will be filled next time it opens'}">Use</button></span>
        <span class="meta">${esc(l.host) || 'no site recorded'} · ${esc(l.source)}${l.own ? ' · saved for this account' : ''}</span>
      </div>`).join('')
    : `<div class="acctlogin empty">No saved login matches this account${data.signInUrl ? ` — sign in once on ${esc(svcOf(svc).name)} and it is remembered` : ''}.</div>`;
  container.querySelectorAll('[data-uselogin]').forEach(b => {
    b.onclick = async () => {
      let msg;
      try {
        await window.api.credsDefault(b.getAttribute('data-uselogin'), svc, id, data.signInUrl || '');
        const r = await window.api.fillLogin(key, b.getAttribute('data-uselogin'));
        if (r && r.choose) msg = ['var(--warn)', 'Set as default. Several logins match — pick one from the banner above.'];
        else if (r && r.ok) msg = ['var(--ok)', `Set as default and filled ${r.filled}.`];
        else msg = ['var(--warn)', `Set as default. ${(r && r.message) || 'Could not fill it here.'}`];
      } catch (err) { msg = ['var(--danger)', errText(err)]; }
      if (box) { box.style.color = msg[0]; box.textContent = msg[1]; }
      renderAccountLogins(key, container, box);
    };
  });
}

// ---------- the rebuilt credential manager (0.9.0) ----------
function openCredsManagerModal() {
  $modalBack.hidden = false;
  $modal.classList.add('wide'); // only this modal is 560 px wide; every other modal keeps 370 px
  window.api.setModalOpen(true);
  $modal.innerHTML = '<h3>Saved logins</h3><div class="note">Loading…</div>';
  let list = [];
  let filter = { kind: 'all', value: '' }; // kind: all | svc | acct
  window.api.credsList().then(rows => {
    list = rows || [];
    render();
  }).catch(err => { closeModal(); alert(errText(err)); });

  // Rows for one login, in the grid: identity | default control | actions. Changing the select only
  // chooses an account; "Apply" sends exactly one instruction to main and re-renders from MAIN's list,
  // so ★ markers are never juggled here (the 0.8.0 desync: two writes could both set a wrong default).
  const rowHtml = c => {
    const defaults = c.defaultForAccounts || [];
    const accounts = c.accounts || [];
    const choices = accounts.map(a => {
      const k = a.key;
      return `<option value="${esc(k)}" ${defaults.includes(k) ? 'selected' : ''}>${esc((svcOf(a.svc).name) + ' · ' + (a.label || a.id))}</option>`;
    }).join('');
    const defaultText = defaults.length
      ? `<span class="creddefault">★ Default for ${defaults.map(k => { const a = registry.find(x => x.key === k); return a ? `${svcOf(a.svc).name} · ${a.label || a.id}` : k; }).join(' · ')}</span>`
      : '';
    return `<div class="credrow">
      <div class="credidentity">
        <strong>${esc(c.username || '(no username)')}</strong>
        <span>${esc(c.host) || 'no site recorded'} · ${esc(c.source)}${c.accountKey ? ` · saved for ${esc(c.accountKey)}` : ''}</span>
        ${!c.host ? '<span class="creddefault" style="color:var(--warn)">No site recorded — this login cannot autofill anywhere. Re-import it with a site, or delete it here.</span>' : ''}
        ${defaultText}
      </div>
      ${accounts.length ? `<div class="creddefaultctl">
        <select data-cred-account="${esc(c.id)}" title="Whose default should this login be?">${choices}</select>
        <button class="btn-plain" data-cred-default="${esc(c.id)}" title="Set this login as the default for the chosen account">Set default</button>
        ${defaults.length ? `<button class="btn-plain" data-cred-clear="${esc(c.id)}" title="Clear this login's default for the chosen account">Clear default</button>` : ''}
      </div>` : '<div class="creddefaultctl"><span class="note" style="margin:0">No account can use this login.</span></div>'}
      <div class="credactions"><button class="btn-plain creddelete" data-cred-del="${esc(c.id)}">Delete</button></div>
    </div>`;
  };

  function render() {
    const svcName = k => (k && svcOf(k).name) || 'Other';
    const servicesWith = [...new Set(list.flatMap(c => c.serviceKeys || []))].sort((a, b) => svcName(a).localeCompare(svcName(b)));
    const accountsWith = [];
    const seenAcct = new Set();
    for (const c of list) for (const a of (c.accounts || [])) if (!seenAcct.has(a.key)) { seenAcct.add(a.key); accountsWith.push(a); }
    accountsWith.sort((a, b) => svcName(a.svc).localeCompare(svcName(b.svc)) || String(a.label).localeCompare(String(b.label)));
    const shown = filter.kind === 'svc' ? list.filter(c => (c.serviceKeys || []).includes(filter.value))
      : filter.kind === 'acct' ? list.filter(c => (c.accounts || []).some(a => a.key === filter.value))
        : list;
    const groups = new Map();
    for (const c of shown) {
      const single = (c.serviceKeys || []).length === 1 ? c.serviceKeys[0] : ((c.serviceKeys || []).length > 1 ? 'shared' : 'other');
      const g = filter.kind === 'svc' ? svcName(filter.value) : single === 'shared' ? 'Shared imports' : svcName(single);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    const chip = (kind, value, label, extra = '') => `<button class="${filter.kind === kind && filter.value === value ? 'on' : ''}" data-cred-filter-kind="${kind}" data-cred-filter-value="${esc(value)}">${extra}${esc(label)}</button>`;
    $modal.innerHTML = `
      <h3>Saved logins <span style="color:var(--muted);font-weight:400;font-size:12px">· ${list.length} stored</span></h3>
      <div class="note" style="margin-top:0">Passwords stay encrypted and are never shown here. Set an account's default, use a login straight away, or delete one. Folders: filter by service or by account.</div>
      <div class="credchips">
        ${chip('all', '', 'All')}
        ${servicesWith.map(k => chip('svc', k, svcName(k), `<span class="dot" style="background:${esc((svcOf(k) || {}).color || '#888')}"></span>`)).join('')}
        ${accountsWith.map(a => chip('acct', a.key, `${svcName(a.svc)} · ${a.label || a.id}`, `<span class="dot" style="background:${colorOf((registry.find(r => r.key === a.key) || {}).colorIdx, a.svc)}"></span>`)).join('')}
      </div>
      ${shown.length ? [...groups.entries()].map(([g, items]) => `<section class="credgroup"><h4>${esc(g)} <span style="text-transform:none;letter-spacing:0">(${items.length})</span></h4>${items.map(rowHtml).join('')}</section>`).join('') : '<div class="note">No saved logins match this filter.</div>'}
      <div id="m-error" style="font-size:11px;margin-top:8px"></div>
      <div class="row"><button class="btn-plain" id="m-cancel">Close</button></div>`;
    $modal.querySelector('#m-cancel').onclick = closeModal;
    $modal.querySelectorAll('[data-cred-filter-kind]').forEach(b => {
      b.onclick = () => { filter = { kind: b.dataset.credFilterKind, value: b.dataset.credFilterValue }; render(); };
    });
    // One write, then re-read from main: the ★ markers can never drift from the stored truth.
    const apply = async (entry, value, clear) => {
      const box = $modal.querySelector('#m-error');
      try {
        if (!value) { box.style.color = 'var(--warn)'; box.textContent = 'Choose an account for this login first.'; return; }
        const [svc, id] = value.split('::');
        list = await window.api.credsDefault(clear ? null : entry.id, svc, id, entry.host);
        credStats = await window.api.credsStats().catch(() => credStats);
        render();
        const box2 = $modal.querySelector('#m-error');
        if (box2) { box2.style.color = 'var(--ok)'; box2.textContent = clear ? 'Default cleared.' : 'Default set.'; }
      } catch (err) {
        const box2 = $modal.querySelector('#m-error');
        if (box2) { box2.style.color = 'var(--danger)'; box2.textContent = errText(err); }
      }
    };
    $modal.querySelectorAll('[data-cred-default]').forEach(b => {
      b.onclick = () => {
        const entry = list.find(c => c.id === b.dataset.credDefault);
        if (!entry) return;
        apply(entry, $modal.querySelector(`[data-cred-account="${CSS.escape(entry.id)}"]`)?.value, false);
      };
    });
    $modal.querySelectorAll('[data-cred-clear]').forEach(b => {
      b.onclick = () => {
        const entry = list.find(c => c.id === b.dataset.credClear);
        if (!entry) return;
        apply(entry, $modal.querySelector(`[data-cred-account="${CSS.escape(entry.id)}"]`)?.value, true);
      };
    });
    $modal.querySelectorAll('[data-cred-del]').forEach(b => {
      b.onclick = async () => {
        const box = $modal.querySelector('#m-error');
        try {
          const r = await window.api.credsDelete(b.getAttribute('data-cred-del'));
          list = r.rows || [];
          await refreshCreds();
          renderHome();
          render();
        } catch (err) { box.style.color = 'var(--danger)'; box.textContent = errText(err); }
      };
    });
  }
  render();
}

function openCredsChooser(key, candidates) {
  const [svc, id] = key.split('::');
  $modal.innerHTML = `
    <h3>${esc(svcOf(svc).name)} · ${esc(id)} — choose a login</h3>
    <div class="note" style="margin-top:0">More than one saved login matches this site. Your choice is remembered as the default for this account.</div>
    ${candidates.map(c => `
      <div class="row"><button class="btn-plain" data-cred="${esc(c.id)}" style="text-align:left">
        ${esc(c.username || '(no username)')} <span style="color:var(--muted);font-size:11px">· ${esc(c.host)} · ${esc(c.source)}</span>
      </button></div>`).join('')}
    <div class="row"><button class="btn-plain" id="m-cancel">Cancel</button></div>`;
  $modalBack.hidden = false;
  window.api.setModalOpen(true);
  $modal.querySelector('#m-cancel').onclick = closeModal;
  $modal.querySelectorAll('[data-cred]').forEach(b => {
    b.onclick = async () => {
      const r = await window.api.fillLogin(key, b.getAttribute('data-cred')).catch(err => ({ ok: false, message: errText(err) }));
      if (r && r.choose) return; // still ambiguous: keep the chooser up
      closeModal();
      if (r && !r.ok) showNotice(key, { kind: 'failed', reason: r.message || 'Could not fill that login on this page.' });
    };
  });
}

function closeModal() { $modalBack.hidden = true; $modal.innerHTML = ''; $modal.classList.remove('wide'); window.api.setModalOpen(false); }
$modalBack.addEventListener('click', e => { if (e.target === $modalBack) closeModal(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (keyPicker) { closeKeyPicker(); return; } // Esc closes the picker first, Home stays put
    if (!$modalBack.hidden) { closeModal(); return; }
    if (state.activeKey !== null) window.api.showHome();
  }
});

// The banner is main's decision, delivered per tab. Only the ACTIVE tab's notice is drawn — the strip
// sits above that tab's view (main reserves exactly its height for that view).
window.api.onAccountNotice(({ key, notice }) => {
  if (notice) { noticeState = { key, notice }; renderInfobar(); return; }
  if (noticeState && noticeState.key === key) { noticeState = null; renderInfobar(); }
});

// ============ wiring ============
async function pollMemory() {
  try {
    const m = await window.api.memory();
    $mem.textContent = `${m.totalMB} MB · ${m.liveTabs} live`;
    // working set counts Chromium's shared pages once per process, so it reads far higher than
    // Task Manager; the headline number is private memory, which matches.
    $mem.title = `${m.totalMB} MB private across ${m.processCount} processes (matches Task Manager)`
      + (m.workingSetMB ? ` · ${m.workingSetMB} MB working set incl. shared pages` : '');
  } catch {}
}
setInterval(pollMemory, 2000);
pollMemory();

function renderAll() { renderTabCtl(); renderTabs(); renderRail(); renderHome(); renderInfobar(); renderKeyChip(); }

window.api.onUpdateState(s => { updateState = s; renderRail(); if (state.activeKey === null) renderHome(); });

window.api.onTabsState(s => {
  const prevFocus = document.activeElement && document.activeElement.id;
  state = Object.assign(state, s);
  if (s.registry) registry = s.registry;
  if (s.services) services = s.services; // keeps user-added services in sync
  // The picker describes one tab's live site: a navigation or a tab switch makes it stale, so it
  // closes (Use/Copy always act through main on the ACTIVE tab anyway, never on a stale list).
  if (keyPicker && !keyPicker.loading && (state.activeKey !== keyPicker.key || !state.siteLogins || state.siteLogins.host !== keyPicker.host)) {
    closeKeyPicker();
  }
  renderAll();
  if (prevFocus === 'filter') { const f = document.getElementById('filter'); if (f) { f.focus(); f.selectionStart = f.value.length; } }
});

(async () => {
  services = await window.api.listServices();
  registry = await window.api.registryList();
  const settings = await window.api.getSettings();
  state.settings = settings || {};
  state.warmLimit = (settings && settings.warmLimit) || 5;
  state.groupTabs = !!(settings && settings.groupTabs);
  state.collapsed = (settings && settings.collapsed) || [];
  state.stripCollapsed = (settings && settings.stripCollapsed) || [];
  credStats = await window.api.credsStats().catch(() => null);
  credStoreState = await window.api.credsStoreState().catch(() => ({ notice: null, error: null }));
  updateState = await window.api.updateState().catch(() => ({ status: 'idle', currentVersion: '' }));
  renderAll();
  window.api.uiReady(); // triggers session restore in main
  window.api.refreshAllStatus().catch(() => {});
  setInterval(() => { if (state.activeKey === null) window.api.refreshAllStatus().catch(() => {}); }, 5 * 60 * 1000);
})();
