// Per-account API token storage: tokens are encrypted with Electron safeStorage (DPAPI on
// Windows) and never sent to the renderer — the renderer only ever receives fetch summaries.
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

function tokensFile() { return path.join(app.getPath('userData'), 'tokens.json'); }

function readTokens() {
  try { return JSON.parse(fs.readFileSync(tokensFile(), 'utf8')); } catch { return {}; }
}
function writeTokens(data) {
  fs.mkdirSync(path.dirname(tokensFile()), { recursive: true });
  fs.writeFileSync(tokensFile(), JSON.stringify(data, null, 2));
}

// value: {ct: base64, createdAt, lastValidated?, validationError?}
async function setToken(key, plainToken) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage unavailable — cannot store tokens');
  const ct = safeStorage.encryptString(plainToken).toString('base64');
  const all = readTokens();
  all[key] = { ct, createdAt: new Date().toISOString() };
  writeTokens(all);
}

async function getToken(key) {
  const entry = readTokens()[key];
  if (!entry) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(entry.ct, 'base64')); } catch { return null; } // DPAPI loss -> re-enter token
}

function tokenMeta(key) {
  const e = readTokens()[key];
  if (!e) return null;
  return { createdAt: e.createdAt, lastValidated: e.lastValidated || null, validationError: e.validationError || null };
}

function markValidated(key, error) {
  const all = readTokens();
  if (!all[key]) return;
  all[key].lastValidated = error ? null : new Date().toISOString();
  all[key].validationError = error || null;
  writeTokens(all);
}

async function clearToken(key) {
  const all = readTokens();
  delete all[key];
  writeTokens(all);
}

module.exports = { setToken, getToken, clearToken, tokenMeta, markValidated };
