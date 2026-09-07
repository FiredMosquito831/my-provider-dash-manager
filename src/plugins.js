// Phase 3: service plugins. A plugin is a JSON manifest describing a service — its URLs, colour,
// multi-account policy, and optionally how to read status from its API. Drop a file in
// <userData>/plugins/ (or install one from the UI) and it becomes a first-class service.
//
// Manifest shape (only key/name/dashboardUrl are required):
// {
//   "key": "flyio",
//   "name": "Fly.io",
//   "dashboardUrl": "https://fly.io/dashboard",
//   "loginUrl":     "https://fly.io/app/sign-in",
//   "signupUrl":    "https://fly.io/app/sign-up",
//   "color": "#8e4ec6",
//   "multiAccountPolicy": "ok" | "warn" | "one-per-person",
//   "api": {                                  // optional: powers the home-card status
//     "validateUrl": "https://api.machines.dev/v1/apps",
//     "authHeader": "Authorization",          // default: Authorization
//     "authFormat": "Bearer {token}",         // default: Bearer {token}
//     "itemsPath": "apps",                    // dot-path to an array (omit if the body IS the array)
//     "namePath": "name"                      // field to show as an item name
//   }
// }
const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');

function pluginsDir() { return path.join(app.getPath('userData'), 'plugins'); }

function isHttpUrl(u) {
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}

// Validate a manifest; returns {ok, service?, error?}. Never throws on bad user input.
function validate(raw, sourceFile) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'manifest must be a JSON object' };
  const key = String(raw.key || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!key) return { ok: false, error: 'missing "key"' };
  if (!raw.name || typeof raw.name !== 'string') return { ok: false, error: 'missing "name"' };
  if (!isHttpUrl(raw.dashboardUrl)) return { ok: false, error: '"dashboardUrl" must be an http(s) URL' };
  for (const f of ['loginUrl', 'signupUrl']) {
    if (raw[f] && !isHttpUrl(raw[f])) return { ok: false, error: `"${f}" must be an http(s) URL` };
  }
  const policy = ['ok', 'warn', 'one-per-person'].includes(raw.multiAccountPolicy) ? raw.multiAccountPolicy : 'ok';
  const color = /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#7c8695';
  let api = null;
  if (raw.api && typeof raw.api === 'object') {
    if (!isHttpUrl(raw.api.validateUrl)) return { ok: false, error: '"api.validateUrl" must be an http(s) URL' };
    api = {
      validateUrl: raw.api.validateUrl,
      authHeader: String(raw.api.authHeader || 'Authorization'),
      authFormat: String(raw.api.authFormat || 'Bearer {token}'),
      itemsPath: raw.api.itemsPath ? String(raw.api.itemsPath) : null,
      namePath: raw.api.namePath ? String(raw.api.namePath) : 'name',
    };
  }
  return {
    ok: true,
    service: {
      key, name: String(raw.name).slice(0, 40),
      dashboardUrl: raw.dashboardUrl,
      loginUrl: raw.loginUrl || raw.dashboardUrl,
      signupUrl: raw.signupUrl || raw.loginUrl || raw.dashboardUrl,
      color, multiAccountPolicy: policy,
      api, plugin: true, sourceFile: sourceFile || null,
    },
  };
}

// Load every manifest in the plugins dir. Bad files are reported, never fatal.
function load() {
  const dir = pluginsDir();
  const services = []; const errors = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')); } catch { return { services, errors }; }
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const res = validate(JSON.parse(fs.readFileSync(full, 'utf8')), f);
      if (res.ok) services.push(res.service);
      else errors.push({ file: f, error: res.error });
    } catch (err) { errors.push({ file: f, error: `invalid JSON: ${err.message}` }); }
  }
  return { services, errors };
}

// Copy a manifest file into the plugins dir after validating it.
function install(srcPath) {
  const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const res = validate(raw, path.basename(srcPath));
  if (!res.ok) throw new Error(res.error);
  fs.mkdirSync(pluginsDir(), { recursive: true });
  const dest = path.join(pluginsDir(), `${res.service.key}.json`);
  fs.copyFileSync(srcPath, dest);
  return res.service;
}

function remove(key) {
  const dest = path.join(pluginsDir(), `${String(key).replace(/[^a-z0-9_-]/gi, '')}.json`);
  if (!fs.existsSync(dest)) throw new Error('plugin file not found');
  fs.rmSync(dest);
  return true;
}

function dig(obj, dotPath) {
  if (!dotPath) return obj;
  return dotPath.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// Generic status provider for plugin services: same contract as the built-in providers.
function makeProvider(api) {
  return {
    async validate(token) {
      const headers = { [api.authHeader]: api.authFormat.replace('{token}', token), Accept: 'application/json' };
      const resp = await net.fetch(api.validateUrl, { headers });
      if (resp.status === 401 || resp.status === 403) throw new Error('TOKEN_INVALID');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json();
      const items = dig(body, api.itemsPath);
      const arr = Array.isArray(items) ? items : (Array.isArray(body) ? body : []);
      return {
        summary: {
          projects: arr.length,
          names: arr.slice(0, 3).map(i => (i && typeof i === 'object' ? dig(i, api.namePath) : i)).filter(Boolean).map(String),
        },
      };
    },
  };
}

// A ready-to-edit example so the format is discoverable from inside the app.
const EXAMPLE = {
  key: 'flyio',
  name: 'Fly.io',
  dashboardUrl: 'https://fly.io/dashboard',
  loginUrl: 'https://fly.io/app/sign-in',
  signupUrl: 'https://fly.io/app/sign-up',
  color: '#8e4ec6',
  multiAccountPolicy: 'ok',
  api: {
    validateUrl: 'https://api.machines.dev/v1/apps',
    authHeader: 'Authorization',
    authFormat: 'Bearer {token}',
    itemsPath: 'apps',
    namePath: 'name',
  },
};

module.exports = { load, install, remove, validate, makeProvider, pluginsDir, EXAMPLE };
