// Dark mode, powered by Dark Reader (MIT, Copyright (c) Dark Reader Ltd.).
//
// WHY THIS IS NOT AN EXTENSION. Dark Reader's own browser extension cannot run correctly in
// Electron 43: its MV3 background service worker dies on APIs Electron does not expose
// (chrome.permissions, chrome.commands), and its MANIFEST-VERSION-3 content script declares
// `world: "MAIN"`, which mutates page prototypes the account's own JavaScript can observe — a
// direct breach of invariant 2 ("account views expose nothing to page JavaScript"). Its main-world
// stylesheets proxy is also observable via Document.prototype.styleSheets.
//
// INSTEAD: Dark Reader ships a self-contained API build on npm (the same engine, no browser
// extension chrome). We run it in a Chromium ISOLATED WORLD of the account view. Measured on this
// repo's Electron 43.6.0:
//   - darkening works: html/body background rgb(255,255,255) -> rgb(24,26,27), text -> rgb(232,230,227)
//   - disable() restores the exact baseline
//   - the page main world keeps `window.DarkReader === undefined`, and
//     Document.prototype.styleSheets stays `[native code]` in BOTH worlds, because we pass
//     {disableStyleSheetsProxy: true}
//   - cost ~1.8-2.5 MB private per enabled view, against ~25 MB per partition for loadExtension
//
// THE ONE GOTCHA: an isolated world's JS globals are discarded with its document, so after a
// cross-origin navigation `DarkReader` is simply gone. We therefore re-inject and re-enable on
// every top-frame navigation. Same-document reloads keep the world, so they need nothing.
const fs = require('fs');
const path = require('path');

// A high id, clear of Electron's own reserved worlds. Verified working on Electron 43.6.0.
const DARK_WORLD_ID = 999;

const BUNDLE_PATH = path.join(__dirname, '..', 'vendor', 'darkreader', 'darkreader.js');
const VERSION_PATH = path.join(__dirname, '..', 'vendor', 'darkreader', 'package.json');

let bundleCache = null;
function bundleCode() {
  if (bundleCache === null) {
    // Reading the string is asar-safe (no extraction needed) and it is ~355 KB, so cache it: every
    // navigation re-evaluates it, and re-reading from disk each time would be wasteful.
    bundleCache = fs.readFileSync(BUNDLE_PATH, 'utf8');
  }
  return bundleCache;
}

function vendoredVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8')).version || ''; } catch { return ''; }
}

// webContents -> the URL we last enabled on. Guards against re-evaluating a 355 KB bundle when a
// navigation is aborted and restarted, and lets disable() know there is something to undo.
const appliedFor = new WeakMap();

function live(wc) {
  return !!wc && !wc.isDestroyed() && typeof wc.executeJavaScriptInIsolatedWorld === 'function';
}

// Evaluate in the view's isolated world. Returns undefined on any failure: a webContents that is
// loading, redirecting or already gone throws, and dark mode is never worth crashing a tab over.
async function inWorld(wc, code) {
  if (!live(wc)) return undefined;
  try {
    return await wc.executeJavaScriptInIsolatedWorld(DARK_WORLD_ID, [{ code }]);
  } catch { return undefined; }
}

// Define DarkReader in this document's isolated world, then turn it on.
// {disableStyleSheetsProxy: true} is the security-relevant flag: without it the only cross-world
// side effect is a proxied Document.prototype.styleSheets getter the page can detect.
async function enable(wc) {
  if (!live(wc)) return false;
  // Evaluating the UMD bundle returns undefined (it assigns to the global; the IIFE has no
  // return value), so do NOT gate on that result — check that DarkReader actually landed instead.
  await inWorld(wc, bundleCode());
  await inWorld(wc, 'window.DarkReader && DarkReader.enable({}, { disableStyleSheetsProxy: true })');
  const on = await inWorld(wc, '!!(window.DarkReader && DarkReader.isEnabled())');
  if (on) appliedFor.set(wc, wc.getURL());
  return !!on;
}

// Turn it off in the same world. The world dies with the document, so this is best-effort: a
// navigation that has already committed simply drops Dark Reader with it.
async function disable(wc) {
  if (!live(wc)) { appliedFor.delete(wc); return true; }
  await inWorld(wc, 'window.DarkReader && DarkReader.disable()');
  appliedFor.delete(wc);
  return true;
}

// Called on every top-frame navigation of an account view. Skipped when the setting is off.
// `url` is the navigation target; a view already dark at this URL is left alone.
async function onNavigate(wc, url) {
  if (!url || appliedFor.get(wc) === url) return false;
  return enable(wc);
}

module.exports = { enable, disable, onNavigate, bundleCode, vendoredVersion, DARK_WORLD_ID };
