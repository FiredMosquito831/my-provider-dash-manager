#!/usr/bin/env node
// Fetches the latest published release and runs its installer.
//
// Used directly (`npm run install:latest`) and as the engine behind scripts/cli.js.
// The repository is public, so no authentication is needed; GH_TOKEN is used only if present
// (which keeps this working if the repo is ever made private again).
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync, spawn } = require('child_process');

const REPO = 'FiredMosquito831/my-provider-dash-manager';

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// accept: JSON for API calls, octet-stream for asset bytes. Without the octet-stream Accept the
// asset endpoint returns metadata instead of the file — a silent failure that yields a 1.7 KB "exe".
function get(url, tok, accept = 'application/vnd.github+json', redirects = 0) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'my-provider-dash-manager', Accept: accept };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    https.get(url, { headers }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirects > 5) return reject(new Error('too many redirects'));
        res.resume();
        return resolve(get(res.headers.location, null, accept, redirects + 1)); // S3 rejects our auth header
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function json(url, tok) {
  const res = await get(url, tok);
  const body = await new Promise((resolve, reject) => {
    let d = ''; res.setEncoding('utf8');
    res.on('data', c => { d += c; }); res.on('end', () => resolve(d)); res.on('error', reject);
  });
  if (res.statusCode === 404) throw new Error('No published release found for this repository.');
  if (res.statusCode === 401 || res.statusCode === 403) throw new Error('GitHub rejected the request (rate limit or token).');
  if (res.statusCode >= 400) throw new Error(`GitHub API returned HTTP ${res.statusCode}`);
  return JSON.parse(body);
}

/** The newest release: { version, notes, asset, url }. */
async function latestRelease() {
  const rel = await json(`https://api.github.com/repos/${REPO}/releases/latest`, token());
  const asset = (rel.assets || []).find(a => a.name.endsWith('.exe'));
  if (!asset) throw new Error(`Release ${rel.tag_name} has no .exe asset.`);
  return {
    version: String(rel.tag_name || '').replace(/^v/, ''),
    notes: rel.body ? String(rel.body).trim() : '',
    url: rel.html_url,
    asset,
  };
}

/** Downloads the release asset to temp and verifies it really is a Windows executable. */
function downloadAsset(rel, onProgress) {
  const dest = path.join(os.tmpdir(), rel.asset.name);
  return new Promise(async (resolve, reject) => {
    try {
      const res = await get(rel.asset.url, token(), 'application/octet-stream');
      if (res.statusCode >= 400) return reject(new Error(`download failed: HTTP ${res.statusCode}`));
      const out = fs.createWriteStream(dest);
      let done = 0; let lastPct = -1;
      res.on('data', c => {
        done += c.length;
        const pct = Math.floor((done / rel.asset.size) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          if (onProgress) onProgress(pct);
          else process.stdout.write(`\r  downloading… ${pct}%`);
        }
      });
      res.pipe(out);
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => out.close(() => {
        if (!onProgress) process.stdout.write('\r  downloading… 100%\n');
        try {
          const stat = fs.statSync(dest);
          const head = Buffer.alloc(2);
          const fd = fs.openSync(dest, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
          if (head.toString('latin1') !== 'MZ') throw new Error(`downloaded file is not a Windows executable (${stat.size} bytes)`);
          if (rel.asset.size && stat.size !== rel.asset.size) throw new Error(`size mismatch: expected ${rel.asset.size}, got ${stat.size}`);
        } catch (e) { return reject(e); }
        resolve(dest);
      }));
    } catch (e) { reject(e); }
  });
}

module.exports = { latestRelease, downloadAsset, REPO };

// Standalone use: download and run, honouring --silent / --download-only.
if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    console.log(`Looking up the latest release of ${REPO}…`);
    const rel = await latestRelease();
    let installed = null;
    try { installed = require('../package.json').version; } catch {}
    console.log(`  latest: ${rel.version}${installed ? `   (this checkout: ${installed})` : ''}`);
    if (rel.notes) console.log(`\n${rel.notes.split('\n').slice(0, 12).join('\n')}\n`);
    console.log(`Downloading ${rel.asset.name} (${(rel.asset.size / 1048576).toFixed(1)} MB)…`);
    const dest = await downloadAsset(rel);
    console.log(`  verified: ${(fs.statSync(dest).size / 1048576).toFixed(1)} MB Windows executable`);
    if (args.includes('--download-only')) return console.log(`\nSaved to ${dest}`);
    console.log(`\nLaunching the installer${args.includes('--silent') ? ' (silent)' : ''}…`);
    spawn(dest, args.includes('--silent') ? ['/S'] : [], { detached: true, stdio: 'ignore' }).unref();
    console.log('The installer is unsigned, so SmartScreen may ask you to confirm.');
  })().catch(err => { console.error(`\nFailed: ${err.message}`); process.exit(1); });
}
