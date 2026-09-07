// Update system: version tracking against the latest GitHub release, release information, and
// in-place updates. With auto-update on (default) a newer release is downloaded in the background and
// installed silently (NSIS /S) either when the app quits or when the user presses "Restart & update" —
// the interactive installer wizard is only ever seen on a first install. Auto-update can be turned off,
// in which case every step waits for a button press.
//
// Packaged builds use electron-updater (real download + install). Unpackaged dev runs still do a
// real version check against the GitHub releases API so the UI is testable and honest about what it
// can and cannot do.
const { app, net } = require('electron');
const tokens = require('./api-tokens');

const REPO = 'FiredMosquito831/my-provider-dash-manager';
const TOKEN_KEY = 'system::github-updates'; // encrypted with DPAPI like every other stored token

// A private repository's release feed is not readable anonymously. Rather than forcing the repo
// public, the user can store a GitHub token with read access; it is used for both the API check and
// electron-updater's feed.
async function getToken() {
  try { return (await tokens.getToken(TOKEN_KEY)) || process.env.GH_TOKEN || null; } catch { return process.env.GH_TOKEN || null; }
}
async function setToken(plain) {
  if (!plain) { await tokens.clearToken(TOKEN_KEY); state.hasToken = false; }
  else { await tokens.setToken(TOKEN_KEY, plain.trim()); state.hasToken = true; }
  await applyFeed();
  notify(snapshot());
  return state.hasToken;
}
async function applyFeed() {
  if (!autoUpdater) return;
  const token = await getToken();
  const [owner, repo] = REPO.split('/');
  try {
    autoUpdater.setFeedURL({ provider: 'github', owner, repo, private: !!token, token: token || undefined });
  } catch (err) { console.error('[updater] feed config failed:', err.message); }
}

const state = {
  currentVersion: null,     // filled on init
  status: 'idle',           // idle | checking | available | up-to-date | downloading | downloaded | error | unsupported
  latestVersion: null,
  releaseNotes: null,
  releaseUrl: null,
  releaseDate: null,
  progress: null,           // {percent, transferred, total, bytesPerSecond}
  error: null,
  lastChecked: null,
  packaged: false,
  canDownload: false,       // only packaged builds can actually install an update
  hasToken: false,          // a stored GitHub token (needed while the repo is private)
  autoUpdate: true,         // download automatically, install silently on quit / on "Restart & update"
};

let notify = () => {};
let autoUpdater = null;
let autoUpdate = true; // mirrors settings.autoUpdate

// How the installer is invoked for an in-place update: silently, and relaunch afterwards.
// (A first install still goes through the interactive wizard — that is the CLI / release page path.)
const INSTALL_MODE = { isSilent: true, isForceRunAfter: true };

function setAutoUpdate(on) {
  autoUpdate = !!on;
  if (autoUpdater) autoUpdater.autoDownload = autoUpdate;
  state.autoUpdate = autoUpdate;
  notify(snapshot());
  // if an update is already known and we just switched auto on, fetch it now
  if (autoUpdate && state.status === 'available' && autoUpdater) download().catch(() => {});
  return autoUpdate;
}

function snapshot() { return { ...state }; }
function push(patch) {
  Object.assign(state, patch);
  notify(snapshot());
}

// Compare semver-ish versions ("1.2.10" > "1.2.9"); returns true when b is newer than a.
function isNewer(a, b) {
  const pa = String(a || '0').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

function init(onChange, opts = {}) {
  notify = onChange || (() => {});
  if (typeof opts.autoUpdate === 'boolean') { autoUpdate = opts.autoUpdate; state.autoUpdate = autoUpdate; }
  state.currentVersion = app.getVersion();
  state.packaged = app.isPackaged;
  state.canDownload = app.isPackaged;
  getToken().then(t => { state.hasToken = !!t; if (t) applyFeed(); notify(snapshot()); }).catch(() => {});

  if (!app.isPackaged) return snapshot(); // dev: GitHub-API checks only, no electron-updater

  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = autoUpdate;     // auto-update on: fetch in the background; off: the user presses Download
    autoUpdater.autoInstallOnAppQuit = true;   // a downloaded update installs silently (/S) on the next quit
    autoUpdater.on('checking-for-update', () => push({ status: 'checking', error: null }));
    autoUpdater.on('update-available', info => push({
      status: 'available',
      latestVersion: info.version,
      releaseNotes: normaliseNotes(info.releaseNotes),
      releaseDate: info.releaseDate || null,
      releaseUrl: `https://github.com/${REPO}/releases/tag/v${info.version}`,
      lastChecked: new Date().toISOString(),
    }));
    autoUpdater.on('update-not-available', info => push({
      status: 'up-to-date',
      latestVersion: (info && info.version) || state.currentVersion,
      lastChecked: new Date().toISOString(),
    }));
    autoUpdater.on('download-progress', p => push({
      status: 'downloading',
      progress: { percent: Math.round(p.percent), transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond },
    }));
    autoUpdater.on('update-downloaded', info => push({
      status: 'downloaded', latestVersion: info.version, progress: null,
    }));
    autoUpdater.on('error', err => push({ status: 'error', error: friendlyError(err), progress: null }));
  } catch (err) {
    push({ status: 'unsupported', error: `updater unavailable: ${err.message}` });
  }
  return snapshot();
}

function normaliseNotes(notes) {
  if (!notes) return null;
  if (typeof notes === 'string') return stripHtml(notes).slice(0, 4000);
  if (Array.isArray(notes)) return notes.map(n => stripHtml(n.note || '')).join('\n\n').slice(0, 4000);
  return null;
}
function stripHtml(s) { return String(s).replace(/<[^>]+>/g, '').trim(); }

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/404|Not Found|cannot find latest/i.test(msg)) {
    return state.hasToken
      ? 'Could not read the release feed even with the stored token — check the token has repo read access.'
      : 'The repository is private: add a GitHub token below (read access is enough), or make the repository public.';
  }
  if (/401|403|Bad credentials/i.test(msg)) return 'The stored GitHub token was rejected — replace it, or make the repository public.';
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|network/i.test(msg)) return 'No network connection.';
  return msg;
}

// Dev-mode (and fallback) check straight against the GitHub releases API.
async function checkViaApi() {
  const token = await getToken();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'my-provider-dash-manager' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (resp.status === 401 || resp.status === 403) throw new Error('The stored GitHub token was rejected — replace it, or make the repository public.');
  if (resp.status === 404) {
    throw new Error(token
      ? 'No published release found for this repository.'
      : 'The repository is private: add a GitHub token below (read access is enough), or make the repository public.');
  }
  if (!resp.ok) throw new Error(`GitHub API returned HTTP ${resp.status}`);
  const r = await resp.json();
  const latest = String(r.tag_name || '').replace(/^v/, '');
  return {
    latestVersion: latest,
    releaseNotes: r.body ? String(r.body).slice(0, 4000) : null,
    releaseUrl: r.html_url,
    releaseDate: r.published_at,
  };
}

async function check() {
  push({ status: 'checking', error: null });
  try {
    if (autoUpdater) {
      await autoUpdater.checkForUpdates();       // events drive the state from here
      return snapshot();
    }
    const info = await checkViaApi();
    push({
      ...info,
      status: isNewer(state.currentVersion, info.latestVersion) ? 'available' : 'up-to-date',
      lastChecked: new Date().toISOString(),
    });
  } catch (err) {
    push({ status: 'error', error: friendlyError(err), lastChecked: new Date().toISOString() });
  }
  return snapshot();
}

async function download() {
  if (!autoUpdater) throw new Error('Updates can only be downloaded from an installed build — this is a dev run.');
  if (state.status !== 'available') throw new Error('No update is available to download.');
  push({ status: 'downloading', progress: { percent: 0 } });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    push({ status: 'error', error: friendlyError(err), progress: null });
    throw new Error(friendlyError(err));
  }
  return snapshot();
}

function install() {
  if (!autoUpdater) throw new Error('Nothing to install — this is a dev run.');
  if (state.status !== 'downloaded') throw new Error('The update has not finished downloading yet.');
  // silent NSIS install (/S) and relaunch — no wizard for an update that is already installed
  setImmediate(() => autoUpdater.quitAndInstall(INSTALL_MODE.isSilent, INSTALL_MODE.isForceRunAfter)); // let the IPC reply return first
  return true;
}

module.exports = { init, check, download, install, snapshot, isNewer, setToken, getToken, setAutoUpdate, INSTALL_MODE, REPO };
