let services = [];
let registry = [];
let state = { activeKey: null, warmLimit: 5, tabs: [] };

const $services = document.getElementById('services');
const $tabs = document.getElementById('tabs');
const $mem = document.getElementById('mem');
const $home = document.getElementById('home');
const $modalBack = document.getElementById('modal-back');
const $modal = document.getElementById('modal');
const $extBtn = document.getElementById('ext-btn');
const $hibAll = document.getElementById('hib-all');
const $left = document.getElementById('left');

function colorOf(colorIdx, svcKey) {
  if (typeof colorIdx === 'number') return PALETTE[colorIdx % PALETTE.length];
  const s = services.find(x => x.key === svcKey);
  return s ? s.color : '#888';
}
const PALETTE = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#00a2c7', '#4f8cff', '#8e4ec6', '#e93d82', '#6e56cf', '#00b0a0'];

const POLICY_TEXT = {
  'ok': '',
  'warn': 'multi-accounting is watched here — use judgment',
  'one-per-person': 'ToS: one account per person — orgs/workspaces are the sanctioned way',
};

// ---------- tab strip ----------
function renderDock() {
  $left.innerHTML = `<div class="dock ${state.activeKey === null ? 'active' : ''}" id="dock-home" title="Home — all your accounts (Esc)">⌂</div>`;
  document.body.classList.add('has-dock');
}

$left.addEventListener('click', async e => {
  const dock = e.target.closest('#dock-home');
  if (dock) {
    if (state.activeKey !== null) await window.api.showHome(); // sleep the active tab; home grid appears
    renderStrip(); renderHome();
  }
});

function renderStrip() {
  $tabs.innerHTML = state.tabs.map(t => {
    const c = colorOf(t.colorIdx, t.svc);
    const svc = services.find(s => s.key === t.svc);
    const name = svc ? svc.name : t.svc;
    const stateDot = t.lastState === 'signin' ? '<span class="state signin" title="On login page — sign-in needed"></span>' : '';
    return `<div class="tab ${t.key === state.activeKey ? 'active' : ''}" data-key="${t.key}" title="${esc(t.url)}">
      <span class="dot" style="background:${c}"></span>${stateDot}
      <span class="label">${esc(name)} · ${esc(t.label)}</span>
      <span class="close" data-close="${t.key}" title="Sleep tab (Ctrl+W)">✕</span>
    </div>`;
  }).join('');
  renderDock(); // must run even with zero tabs (was dead code inside the map callback)
  renderServiceRail();
  $extBtn.hidden = state.activeKey === null;
}

function renderServiceRail() {
  $services.innerHTML = services.map(s => {
    const open = state.tabs.filter(t => t.svc === s.key).length;
    return `<div class="svc" data-svc="${s.key}" title="${s.name}">
      <span class="dot" style="background:${s.color}"></span><span>${s.name}${open ? ` (${open})` : ''}</span>
      <span class="add" data-add="${s.key}" title="Add account of ${s.name}">＋</span>
    </div>`;
  }).join('');
}

$services.addEventListener('click', e => {
  const add = e.target.closest('[data-add]');
  if (add) { openAddModal(add.getAttribute('data-add')); return; }
  const svcEl = e.target.closest('[data-svc]');
  if (svcEl) {
    const svc = svcEl.getAttribute('data-svc');
    const first = state.tabs.find(t => t.svc === svc);
    if (first) { window.api.activateTab(first.key); return; }
    const acc = registry.find(a => a.svc === svc);
    if (acc) { window.api.openAccount(acc.svc, acc.id); return; } // hibernated account: reopen it, don't offer to add
    openAddModal(svc);
  }
});

$tabs.addEventListener('click', e => {
  const close = e.target.closest('[data-close]');
  if (close) { window.api.sleepTab(close.getAttribute('data-close')); return; }
  const tabEl = e.target.closest('[data-key]');
  if (tabEl) window.api.activateTab(tabEl.getAttribute('data-key'));
});

$hibAll.addEventListener('click', () => window.api.sleepAll());
$extBtn.addEventListener('click', async () => {
  const url = await window.api.activeTabUrl();
  if (url) window.api.openExternal(url);
});

// ---------- home grid ----------
function renderHome() {
  if (state.activeKey !== null) { $home.hidden = true; return; }
  $home.hidden = false;
  if (document.activeElement && document.activeElement.id === 'warm-limit') return; // don't blow away the input mid-edit
  const grouped = services.map(svc => {
    const accs = registry.filter(a => a.svc === svc.key);
    return { svc, accs };
  });
  $home.innerHTML = `
    <h2>Accounts</h2>
    <div class="sub">Warm-tab limit: <input type="number" id="warm-limit" min="1" max="15" value="${state.warmLimit}" style="width:3.5em;background:var(--panel2);color:var(--text);border:1px solid #3a3f4a;border-radius:5px;padding:2px 5px;"> · <button class="act" id="refresh-status" title="Re-fetch API status for all connected accounts">↻ Refresh status</button> · click a card to open its dashboard (sessions persist per account)</div>
    ${grouped.map(({ svc, accs }) => `
      <div class="svcgroup">
        <div class="head">
          <span class="dot" style="background:${svc.color}"></span>
          <span class="name">${svc.name}</span>
          ${POLICY_TEXT[svc.multiAccountPolicy] ? `<span class="policy">⚠ ${POLICY_TEXT[svc.multiAccountPolicy]}</span>` : ''}
        </div>
        <div class="cards">
          ${accs.map(a => {
            const st = a.status;
            let statusText = '';
            if (a.hasToken && st && st.summary) {
              const names = st.summary.names && st.summary.names.length ? ` · ${esc(st.summary.names.join(', '))}` : '';
              statusText = `<span style="color:#7ee2a8">${st.summary.projects} projects</span>${names}`;
              if (st.summary.latest) statusText += ` · last deploy ${esc(String(st.summary.latest.state || ''))}`;
            } else if (a.hasToken && st && st.error) {
              statusText = `<span class="warn">API: ${esc(st.error)}</span>`;
            } else if (a.hasToken && !st) {
              statusText = '<span style="color:var(--muted)">checking…</span>';
            }
            return `
            <div class="card" data-open="${esc(a.key)}" title="Open ${esc(svc.name)} / ${esc(a.label)}">
              <div class="top"><span class="dot" style="background:${colorOf(a.colorIdx, a.svc)}"></span><span class="label">${esc(a.label)}</span><span class="gear" data-gear="${esc(a.key)}" title="Manage / token / proxy / delete">⚙</span></div>
              <div class="meta">${a.lastState === 'signin' ? '<span class="warn">sign-in needed</span>' : (a.lastState === 'ok' ? 'signed in' : '')}${statusText ? ' · ' + statusText : ''}</div>
            </div>`;
          }).join('')}
          <div class="card addcard" data-add2="${svc.key}" title="Add a ${svc.name} account">＋ Add account</div>
        </div>
      </div>`).join('')}`;
}

$home.addEventListener('change', async e => {
  if (e.target && e.target.id === 'warm-limit') {
    state.warmLimit = await window.api.setWarmLimit(Number(e.target.value)); // returns the clamped value
    renderHome();
  }
});

$home.addEventListener('click', async e => {
  if (e.target && e.target.id === 'refresh-status') {
    e.target.disabled = true;
    e.target.textContent = '↻ Refreshing…';
    await window.api.refreshAllStatus(); // result arrives via the tabs-state registry payload
  }
});

$home.addEventListener('click', e => {
  const gear = e.target.closest('[data-gear]');
  if (gear) { e.stopPropagation(); openEditModal(gear.getAttribute('data-gear')); return; }
  const add = e.target.closest('[data-add2]');
  if (add) { openAddModal(add.getAttribute('data-add2')); return; }
  const card = e.target.closest('[data-open]');
  if (card) {
    const [svc, id] = card.getAttribute('data-open').split('::');
    window.api.openAccount(svc, id);
  }
});

// ---------- modals ----------
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function openAddModal(svc) {
  const service = services.find(s => s.key === svc);
  const existing = registry.filter(a => a.svc === svc).length;
  const policy = POLICY_TEXT[service.multiAccountPolicy];
  $modal.innerHTML = `
    <h3>Add ${esc(service.name)} account</h3>
    <label>Account name</label>
    <input type="text" id="m-label" value="acc${existing + 1}" />
    <div class="row">
      <button class="btn-primary" id="m-login">I have an account — Log in</button>
    </div>
    <div class="row">
      <button class="btn-plain" id="m-signup">Create a new account (guided)</button>
    </div>
    ${policy ? `<div class="note">⚠ ${esc(policy)}. Signup is manual inside this account's own isolated session — never automated.</div>` : '<div class="note">The session opens inside this account’s own isolated browser storage. Avoid Google login (blocked in embedded browsers) — use email/password or GitHub.</div>'}
    <div id="m-error" style="color:#ff6b6b;margin-top:8px"></div>
    <div class="row"><button class="btn-plain" id="m-cancel">Cancel</button></div>`;
  $modalBack.hidden = false;
  window.api.setModalOpen(true); // hide account views so the modal is visible/clickable above them
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
    if (box) box.textContent = `Failed to add account: ${err.message}`;
  }
}

function openEditModal(key) {
  const [svc, id] = key.split('::');
  const acc = registry.find(a => a.svc === svc && a.id === id);
  if (!acc) return;
  $modal.innerHTML = `
    <h3>Edit ${esc(svc)} · ${esc(acc.label)}</h3>
    <label>Display name</label>
    <input type="text" id="m-label" value="${esc(acc.label)}" />
    <label>API token (optional — read-only, encrypted with Windows DPAPI, shown only to the service API)</label>
    <input type="password" id="m-token" placeholder="${acc.hasToken ? 'token stored — paste to replace' : 'paste token to connect'}" />
    <div class="row"><button class="btn-plain" id="m-token-save">Validate & save token</button>${acc.hasToken ? '<button class="btn-plain" id="m-token-clear">Remove token</button>' : ''}</div>
    <label>Proxy (optional — http://host:port or socks5://host:port)</label>
    <input type="text" id="m-proxy" value="${esc(acc.proxy || '')}" placeholder="system default" />
    <div class="row"><button class="btn-primary" id="m-save">Save</button><button class="btn-plain" id="m-cancel">Cancel</button></div>
    <div class="row"><button class="btn-danger" id="m-del" title="Deletes the account's session data on disk">Delete account & wipe session</button></div>
    <div id="m-error" style="color:#7ee2a8;font-size:11px;margin-top:8px"></div>
    <div class="note">Renaming changes only the label — the account's stored session stays bound to it. Deleting is irreversible. Tokens are validated before being stored and are never sent anywhere except that service's own API. Note: Netlify tokens are necessarily full-scope (they offer no read-only tier).</div>`;
  $modalBack.hidden = false;
  window.api.setModalOpen(true); // hide account views so the modal is visible/clickable above them
  $modal.querySelector('#m-cancel').onclick = closeModal;
  const saveBtn = $modal.querySelector('#m-save');
  const labelInput = $modal.querySelector('#m-label');
  const syncSave = () => { saveBtn.disabled = !labelInput.value.trim(); }; // blank label: Save disabled, no silent keep-old
  labelInput.addEventListener('input', syncSave);
  syncSave();
  const tokenBox = $modal.querySelector('#m-error');
  $modal.querySelector('#m-token-save').onclick = async () => {
    const plain = $modal.querySelector('#m-token').value.trim();
    if (!plain) { tokenBox.style.color = '#ff6b6b'; tokenBox.textContent = 'Paste a token first.'; return; }
    tokenBox.style.color = 'var(--muted)';
    tokenBox.textContent = 'Validating with the service…';
    try {
      await window.api.setAccountToken(svc, id, plain);
      tokenBox.style.color = '#7ee2a8';
      tokenBox.textContent = 'Token validated and stored — card status will update.';
      setTimeout(() => { closeModal(); }, 800);
    } catch (err) {
      tokenBox.style.color = '#ff6b6b';
      tokenBox.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
  const clearBtn = $modal.querySelector('#m-token-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    await window.api.clearAccountToken(svc, id);
    closeModal();
  };
  $modal.querySelector('#m-save').onclick = async () => {
    await window.api.updateAccount(svc, id, {
      label: labelInput.value,
      proxy: $modal.querySelector('#m-proxy').value,
    });
    closeModal();
  };
  $modal.querySelector('#m-del').onclick = async () => {
    if (confirm(`Delete ${svc} / ${acc.label} and wipe its stored session? This cannot be undone.`)) {
      await window.api.deleteAccount(svc, id);
      closeModal();
    }
  };
}

function closeModal() { $modalBack.hidden = true; $modal.innerHTML = ''; window.api.setModalOpen(false); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$modalBack.hidden) { closeModal(); return; }
  if (e.key === 'Escape' && state.activeKey !== null) {
    window.api.showHome(); // dedicated Home: Esc from any tab returns to the account grid
  }
});
$modalBack.addEventListener('click', e => { if (e.target === $modalBack) closeModal(); });

// ---------- memory readout ----------
async function pollMemory() {
  const m = await window.api.memory();
  $mem.textContent = `${m.totalMB} MB · ${m.liveTabs} live`;
}
setInterval(pollMemory, 2000);
pollMemory();

// ---------- wiring ----------
window.api.onTabsState(s => {
  state = s;
  if (s.registry) registry = s.registry; // live registry projection: add/rename/delete/state changes reach the home grid immediately
  renderStrip();
  renderHome();
});
(async () => {
  services = await window.api.listServices();
  registry = await window.api.registryList();
  const settings = await window.api.getSettings();
  state.warmLimit = (settings && settings.warmLimit) || 5;
  renderStrip();
  renderHome();
  window.api.refreshAllStatus().catch(() => {}); // light up connected cards on startup
  setInterval(() => { if (state.activeKey === null) window.api.refreshAllStatus().catch(() => {}); }, 5 * 60 * 1000);
})();
window.api.uiReady();
