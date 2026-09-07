// Native ad-blocking + dark mode (the uBlock Origin / Dark Reader equivalents).
// Electron cannot load Chrome extensions (see DECISIONS D10), so these are built in:
//   - blocking: webRequest filter driven by EasyList network rules (||host^ subset)
//   - cosmetic: generic ##selector rules injected as display:none CSS
//   - dark mode: nativeTheme dark (sites with their own dark theme) + optional invert filter
const { app, net, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const LIST_URL = 'https://easylist.to/easylist/easylist.txt';
const LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const MAX_COSMETIC = 4000; // cap injected selectors so CSS stays small

// Minimal seed list so blocking works before/without a successful EasyList fetch.
const SEED_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagservices.com', 'adservice.google.com', 'adnxs.com', 'criteo.com', 'criteo.net',
  'taboola.com', 'outbrain.com', 'scorecardresearch.com', 'quantserve.com', 'moatads.com',
  'zedo.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com',
  'advertising.com', 'adform.net', 'smartadserver.com', 'teads.tv', 'sharethrough.com',
  'amazon-adsystem.com', 'bidswitch.net', 'yieldmo.com', 'adroll.com', 'ads-twitter.com',
];

const filters = {
  hosts: new Set(SEED_HOSTS),
  substrings: [],
  cosmetic: [],
  exceptions: new Set(),
  loadedFrom: 'seed',
};

function listPath() { return path.join(app.getPath('userData'), 'filters', 'easylist.txt'); }

// EasyList subset parser: ||host^ network rules, generic ##selector cosmetic rules, @@ exceptions.
function parseList(text) {
  const hosts = new Set(SEED_HOSTS);
  const substrings = [];
  const cosmetic = [];
  const exceptions = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;
    if (line.startsWith('@@')) { // exception rule — keep host allowlisted
      const m = line.match(/^@@\|\|([a-z0-9.-]+)\^/i);
      if (m) exceptions.add(m[1].toLowerCase());
      continue;
    }
    if (line.includes('##')) { // cosmetic
      const [domains, sel] = line.split('##');
      if (!domains && sel && cosmetic.length < MAX_COSMETIC && !sel.includes(':')) cosmetic.push(sel); // generic only
      continue;
    }
    if (line.includes('#@#') || line.includes('#?#')) continue;
    const m = line.match(/^\|\|([a-z0-9.*-]+)\^?/i);
    if (m && !m[1].includes('*')) { hosts.add(m[1].toLowerCase()); continue; }
    if (line.length > 6 && !line.includes('$') && /^[a-z0-9/._-]+$/i.test(line) && substrings.length < 800) {
      substrings.push(line.toLowerCase());
    }
  }
  return { hosts, substrings, cosmetic, exceptions };
}

function applyParsed(p, from) {
  filters.hosts = p.hosts;
  filters.substrings = p.substrings;
  filters.cosmetic = p.cosmetic;
  filters.exceptions = p.exceptions;
  filters.loadedFrom = from;
}

async function fetchList() {
  const resp = await net.fetch(LIST_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  fs.mkdirSync(path.dirname(listPath()), { recursive: true });
  fs.writeFileSync(listPath(), text);
  return text;
}

// Load cached list, refreshing in the background when stale. Never blocks startup.
async function loadFilters() {
  try {
    const p = listPath();
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      applyParsed(parseList(fs.readFileSync(p, 'utf8')), 'cache');
      if (Date.now() - stat.mtimeMs > LIST_MAX_AGE_MS) {
        fetchList().then(t => applyParsed(parseList(t), 'network')).catch(() => {});
      }
      return filters.loadedFrom;
    }
    const text = await fetchList();
    applyParsed(parseList(text), 'network');
  } catch (err) {
    console.error('[adblock] list load failed, using seed list:', err.message);
  }
  return filters.loadedFrom;
}

function hostBlocked(hostname) {
  let h = hostname.toLowerCase();
  if (filters.exceptions.has(h)) return false;
  // match the host and every parent domain (ads.foo.example.com -> example.com)
  for (;;) {
    if (filters.hosts.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot === -1) return false;
    h = h.slice(dot + 1);
    if (!h.includes('.')) return false;
  }
}

function shouldBlock(url, resourceType) {
  if (resourceType === 'mainFrame') return false; // never block the page the user asked for
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (hostBlocked(u.hostname)) return true;
    const lower = url.toLowerCase();
    for (const s of filters.substrings) if (lower.includes(s)) return true;
    return false;
  } catch { return false; }
}

const attached = new WeakSet();
const stats = { blocked: 0 };

// One webRequest handler per partition session; toggled live via isEnabled().
function attachAdBlock(ses, isEnabled) {
  if (attached.has(ses)) return;
  attached.add(ses);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (isEnabled() && shouldBlock(details.url, details.resourceType)) {
      stats.blocked++;
      return callback({ cancel: true });
    }
    callback({});
  });
}

function cosmeticCss() {
  if (!filters.cosmetic.length) return '';
  return `${filters.cosmetic.join(',')}{display:none!important}`;
}

// Dark Reader-style fallback for sites with no dark theme of their own.
const FORCE_DARK_CSS = `
html{filter:invert(1) hue-rotate(180deg)!important;background:#111!important}
img,video,iframe,svg,canvas,picture,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}
`;

async function applyToPage(wc, { adBlock, forceDark }) {
  try {
    if (adBlock) { const css = cosmeticCss(); if (css) await wc.insertCSS(css); }
    if (forceDark) await wc.insertCSS(FORCE_DARK_CSS);
  } catch { /* page may have navigated away */ }
}

function setNativeDark(on) {
  nativeTheme.themeSource = on ? 'dark' : 'system'; // makes prefers-color-scheme sites go dark natively
}

module.exports = { loadFilters, attachAdBlock, applyToPage, setNativeDark, stats, filters };
