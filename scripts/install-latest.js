#!/usr/bin/env node
// Fetch the latest published release and run its installer.
//
//   npm run install:latest              download + launch the installer
//   npm run install:latest -- --silent  install without the wizard UI
//   npm run install:latest -- --download-only
//
// Auth: the repository is private, so a token is required — GH_TOKEN/GITHUB_TOKEN from the
// environment, or whatever `gh auth token` returns. Making the repo public removes that need.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync, spawn } = require('child_process');

const REPO = 'FiredMosquito831/my-provider-dash-manager';
const args = process.argv.slice(2);
const silent = args.includes('--silent');
const downloadOnly = args.includes('--download-only');

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

// accept: 'application/vnd.github+json' for API calls, 'application/octet-stream' for asset bytes.
// Without the octet-stream Accept, the asset endpoint returns JSON metadata instead of the file.
function get(url, tok, accept = 'application/vnd.github+json', redirects = 0) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'my-provider-dash-manager-installer', Accept: accept };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    https.get(url, { headers }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirects > 5) return reject(new Error('too many redirects'));
        res.resume();
        // S3 asset redirects reject an Authorization header, so drop it after the first hop
        return resolve(get(res.headers.location, null, accept, redirects + 1));
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
  if (res.statusCode === 404) throw new Error('Release not found. The repo is private — set GH_TOKEN or run `gh auth login`.');
  if (res.statusCode === 401 || res.statusCode === 403) throw new Error('GitHub rejected the token (needs read access to this repo).');
  if (res.statusCode >= 400) throw new Error(`GitHub API returned HTTP ${res.statusCode}`);
  return JSON.parse(body);
}

function download(url, tok, dest, size) {
  return new Promise(async (resolve, reject) => {
    const res = await get(url, tok, 'application/octet-stream');
    if (res.statusCode >= 400) return reject(new Error(`download failed: HTTP ${res.statusCode}`));
    const out = fs.createWriteStream(dest);
    let done = 0; let lastPct = -1;
    res.on('data', c => {
      done += c.length;
      if (size) {
        const pct = Math.floor((done / size) * 100);
        if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`\r  downloading… ${pct}%`); }
      }
    });
    res.pipe(out);
    out.on('finish', () => { process.stdout.write('\r  downloading… 100%\n'); out.close(() => resolve(dest)); });
    out.on('error', reject);
    res.on('error', reject);
  });
}

(async () => {
  const tok = token();
  if (!tok) console.warn('! No GitHub token found (GH_TOKEN or `gh auth login`) — this will fail while the repo is private.\n');

  console.log(`Looking up the latest release of ${REPO}…`);
  const rel = await json(`https://api.github.com/repos/${REPO}/releases/latest`, tok);
  const version = String(rel.tag_name || '').replace(/^v/, '');
  const asset = (rel.assets || []).find(a => a.name.endsWith('.exe'));
  if (!asset) throw new Error(`Release ${rel.tag_name} has no .exe asset.`);

  let installed = null;
  try { installed = require('../package.json').version; } catch {}
  console.log(`  latest: ${version}${installed ? `   (this checkout: ${installed})` : ''}`);
  if (rel.body) console.log(`\n${String(rel.body).trim().split('\n').slice(0, 12).join('\n')}\n`);

  const dest = path.join(os.tmpdir(), asset.name);
  console.log(`Downloading ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB)…`);
  await download(asset.url, tok, dest, asset.size); // .url (not browser_download_url) works for private repos

  // Never hand a non-executable to spawn(): the asset endpoint returns JSON metadata unless the
  // request asks for octet-stream, and that failure is otherwise silent.
  const stat = fs.statSync(dest);
  const head = Buffer.alloc(2);
  const fd = fs.openSync(dest, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
  if (head.toString('latin1') !== 'MZ') throw new Error(`downloaded file is not a Windows executable (${stat.size} bytes)`);
  if (asset.size && stat.size !== asset.size) throw new Error(`size mismatch: expected ${asset.size} bytes, got ${stat.size}`);
  console.log(`  verified: ${(stat.size / 1048576).toFixed(1)} MB Windows executable`);

  if (downloadOnly) { console.log(`\nSaved to ${dest}`); return; }

  console.log(`\nLaunching the installer${silent ? ' (silent)' : ''}…`);
  const child = spawn(dest, silent ? ['/S'] : [], { detached: true, stdio: 'ignore', shell: false });
  child.unref();
  console.log('The installer is running. It is unsigned, so SmartScreen may ask you to confirm.');
})().catch(err => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
