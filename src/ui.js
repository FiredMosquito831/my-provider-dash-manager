let services = [];
let registry = [];
let state = { activeKey: null, warmLimit: 5, tabs: [], groupTabs: false, collapsed: [] };
let filterText = '';
let credStats = null;
let updateState = { status: 'idle', currentVersion: '' };

const $tabctl = document.getElementById('tabctl');
const $tabs = document.getElementById('tabs');
const $mem = document.getElementById('mem');
const $home = document.getElementById('home');
const $modalBack = document.getElementById('modal-back');
const $modal = document.getElementById('modal');
const $extBtn = document.getElementById('ext-btn');
const $hibAll = document.getElementById('hib-all');
const $railTop = document.getElementById('railtop');
const $railScroll = document.getElementById('railscroll');
const $railFoot = document.getElementById('railfoot');

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
}
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
  return `<div class="acct ${isActive ? 'active' : ''} ${tab ? 'open' : ''}" data-row="${esc(a.key)}" title="${esc(a.label)}">
    <span class="dot" style="background:${colorOf(a.colorIdx, a.svc)}"></span>
    <span class="aname">${esc(a.label)}</span>
    ${badge}
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
    try { await window.api.fillLogin(fill.getAttribute('data-fill')); }
    catch (err) { alert(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
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
  const editing = document.activeElement && document.activeElement.id === 'warm-limit';
  const keepValue = editing ? document.activeElement.value : null;
  const st = state.settings || {};
  $home.innerHTML = `
    <h2>Accounts</h2>
    <div class="sub">
      <span>Warm-tab limit: <input type="number" id="warm-limit" min="1" max="15" value="${state.warmLimit}"></span>
      <button class="ctlbtn" id="refresh-status" title="Re-fetch API status for all connected accounts">${icon('refresh')} Refresh status</button>
      <button class="ctlbtn ${st.adBlock ? 'on' : ''}" id="t-adBlock" title="Block ads and trackers in account tabs (uBlock-style, built in)">${icon('shield')} Ad-block${state.blocked ? ` · ${state.blocked}` : ''}</button>
      <button class="ctlbtn ${st.darkMode ? 'on' : ''}" id="t-darkMode" title="Ask sites for their own dark theme (prefers-color-scheme)">${icon('moon')} Dark sites</button>
      <button class="ctlbtn ${st.forceDark ? 'on' : ''}" id="t-forceDark" title="Force dark on sites with no dark theme (Dark Reader-style inversion)">${icon('contrast')} Force dark</button>
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
    ${pickerHtml('data-add2')}
    ${updatePanel()}
    <div class="svcgroup">
      <div class="head"><span class="name">Saved logins</span>
        <span class="policy">${(state.credCount != null ? state.credCount : (credStats ? credStats.total : 0))} stored · encrypted with Windows DPAPI</span></div>
      <div class="sub" style="margin-bottom:0">
        <button class="ctlbtn ${st.saveLogins ? 'on' : ''}" id="t-saveLogins" title="Remember logins you type in account tabs">${icon('key')} Remember logins</button>
        <button class="ctlbtn ${st.autofill ? 'on' : ''}" id="t-autofill" title="Fill the saved login automatically when a sign-in page appears">${icon('play')} Auto-fill</button>
        <button class="ctlbtn" id="imp-browser" title="Import saved passwords from an installed browser">${icon('download')} Import from browser</button>
        <button class="ctlbtn" id="imp-csv" title="Import a password CSV exported from any browser">${icon('download')} Import CSV</button>
        ${(state.credCount || (credStats && credStats.total)) ? `<button class="ctlbtn" id="imp-clear" title="Delete every stored login">${icon('x')} Clear</button>` : ''}
      </div>
    </div>`;
  restoreHomeFocus(keepValue); // re-renders no longer kick you out of the warm-limit field
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
  const meta = [openState, signState, statusText].filter(Boolean).join(' · ');
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
      if (r) { credStats = await window.api.credsStats(); renderHome(); alert(`Imported ${r.added} new logins (${r.found} found, ${credStats.total} stored).`); }
    } catch (err) { alert(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    return;
  }
  if (e.target.closest('#imp-clear')) {
    if (confirm('Delete every stored login? Sessions stay signed in; only saved passwords are removed.')) {
      await window.api.credsClear();
      credStats = await window.api.credsStats();
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
      : '<div class="note">No Chrome, Edge, Brave, Vivaldi or Opera profile with saved passwords was found.</div>'}
    <div id="m-error" style="font-size:11px;margin-top:10px;line-height:1.5"></div>
    <div class="row"><button class="btn-plain" id="m-cancel">Close</button></div>
    <div class="note">Close the browser first so its password database is readable. Chrome 127+ can lock entries with app-bound encryption — those must be exported to CSV from the browser instead (Settings → Passwords → Export). Firefox always uses the CSV path.</div>`;
  $modal.querySelector('#m-cancel').onclick = closeModal;
  $modal.querySelectorAll('[data-imp]').forEach(btn => {
    btn.onclick = async () => {
      const b = list[Number(btn.getAttribute('data-imp'))];
      const box = $modal.querySelector('#m-error');
      box.style.color = 'var(--muted)';
      box.textContent = 'Importing…';
      try {
        const r = await window.api.credsImportBrowser(b.id);
        credStats = await window.api.credsStats();
        box.style.color = r.added ? 'var(--ok)' : 'var(--warn)';
        box.textContent = `${r.added} new logins imported (${r.found} readable of ${r.found + r.locked + r.failed}).` + (r.note ? ` ${r.note}` : '');
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

function closeModal() { $modalBack.hidden = true; $modal.innerHTML = ''; window.api.setModalOpen(false); }
$modalBack.addEventListener('click', e => { if (e.target === $modalBack) closeModal(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$modalBack.hidden) { closeModal(); return; }
    if (state.activeKey !== null) window.api.showHome();
  }
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

function renderAll() { renderTabCtl(); renderTabs(); renderRail(); renderHome(); }

window.api.onUpdateState(s => { updateState = s; renderRail(); if (state.activeKey === null) renderHome(); });

window.api.onTabsState(s => {
  const prevFocus = document.activeElement && document.activeElement.id;
  state = Object.assign(state, s);
  if (s.registry) registry = s.registry;
  if (s.services) services = s.services; // keeps user-added services in sync
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
  updateState = await window.api.updateState().catch(() => ({ status: 'idle', currentVersion: '' }));
  renderAll();
  window.api.uiReady(); // triggers session restore in main
  window.api.refreshAllStatus().catch(() => {});
  setInterval(() => { if (state.activeKey === null) window.api.refreshAllStatus().catch(() => {}); }, 5 * 60 * 1000);
})();
