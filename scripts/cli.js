#!/usr/bin/env node
// Command line for My Provider Dash Manager.
//
//   npx my-provider-dash-manager            install (or update) and launch the app
//   npx my-provider-dash-manager install    install/update only, do not launch
//   npx my-provider-dash-manager update     alias of install — always fetches the newest release
//   npx my-provider-dash-manager start      launch the installed app
//   npx my-provider-dash-manager status     what is installed, what is available, where data lives
//   npx my-provider-dash-manager uninstall  run the app's uninstaller
//   npx my-provider-dash-manager where      print the install and data paths
//
// Flags: --silent (no wizard) · --interactive (wizard even for an update) · --download-only · --version · --help
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { latestRelease, downloadAsset } = require('./install-latest.js');

const PRODUCT = 'My Provider Dash Manager';
const DATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'multi-acc-manager');
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('-')));
const cmd = (args.find(a => !a.startsWith('-')) || 'default').toLowerCase();

function pkgVersion() {
  try { return require('../package.json').version; } catch { return 'unknown'; }
}

// Where NSIS puts a per-user install, plus the usual per-machine fallbacks.
function installedExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', PRODUCT, `${PRODUCT}.exe`),
    path.join(process.env.PROGRAMFILES || '', PRODUCT, `${PRODUCT}.exe`),
    path.join(process.env['PROGRAMFILES(X86)'] || '', PRODUCT, `${PRODUCT}.exe`),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function installedUninstaller() {
  const exe = installedExe();
  if (!exe) return null;
  const dir = path.dirname(exe);
  const u = fs.readdirSync(dir).find(f => /^Uninstall .*\.exe$/i.test(f));
  return u ? path.join(dir, u) : null;
}

// Windows reports a four-part ProductVersion (0.2.3.0); releases are three-part (0.2.3).
function normaliseVersion(v) {
  if (!v) return null;
  const parts = String(v).trim().split('.').slice(0, 3);
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

function installedVersion() {
  const exe = installedExe();
  if (!exe) return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', timeout: 15000 });
    return normaliseVersion(out.trim()) || null;
  } catch { return null; }
}

function launch() {
  const exe = installedExe();
  if (!exe) throw new Error('The app is not installed yet — run: npx my-provider-dash-manager install');
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  console.log(`Launched ${PRODUCT}.`);
}

async function install({ launchAfter }) {
  const rel = await latestRelease();
  const have = installedVersion();
  if (have === rel.version && !flags.has('--force')) {
    console.log(`Already on the latest version (${have}).`);
    if (launchAfter) launch();
    return;
  }
  console.log(have ? `Installed: ${have} → updating to ${rel.version}` : `Installing ${rel.version}`);
  if (rel.notes) console.log(`\n${rel.notes.split('\n').slice(0, 10).join('\n')}\n`);
  const dest = await downloadAsset(rel);
  if (flags.has('--download-only')) { console.log(`\nSaved to ${dest}`); return; }
  // An update over an existing install runs silently (no wizard) unless --interactive is given;
  // a first install shows the wizard unless --silent is given.
  const silent = flags.has('--silent') || (!!have && !flags.has('--interactive'));
  console.log(`\nRunning the installer${silent ? ' (silent, in place)' : ''}…`);
  if (silent && have) console.log('Close the app if it is running, or the running copy keeps the old version until restarted.');
  const child = spawn(dest, silent ? ['/S'] : [], { detached: true, stdio: 'ignore' });
  child.unref();
  if (!silent) console.log('The installer is unsigned, so SmartScreen may ask you to confirm.');
  if (launchAfter && silent) {
    setTimeout(() => { try { launch(); } catch (e) { console.error(e.message); } }, 15000);
  }
}

async function status() {
  const have = installedVersion();
  const exe = installedExe();
  let latest = null;
  try { latest = (await latestRelease()).version; } catch (e) { latest = `unavailable (${e.message})`; }
  console.log(`${PRODUCT}`);
  console.log(`  installed:  ${have || 'not installed'}`);
  console.log(`  latest:     ${latest}`);
  console.log(`  cli:        ${pkgVersion()}`);
  console.log(`  app:        ${exe || '—'}`);
  console.log(`  data:       ${fs.existsSync(DATA_DIR) ? DATA_DIR : DATA_DIR + '  (not created yet)'}`);
  if (have && typeof latest === 'string' && have !== latest && !latest.startsWith('unavailable')) {
    console.log(`\nAn update is available — run: npx my-provider-dash-manager update`);
  }
}

function where() {
  console.log(`app:  ${installedExe() || 'not installed'}`);
  console.log(`data: ${DATA_DIR}`);
}

function uninstall() {
  const u = installedUninstaller();
  if (!u) throw new Error('No uninstaller found — the app does not appear to be installed.');
  console.log('Starting the uninstaller. Your accounts and sessions in the data folder are NOT removed;');
  console.log(`delete ${DATA_DIR} yourself if you want them gone.`);
  spawn(u, [], { detached: true, stdio: 'ignore' }).unref();
}

function help() {
  console.log(`${PRODUCT} — CLI ${pkgVersion()}

  npx my-provider-dash-manager             install (or update) and launch
  npx my-provider-dash-manager install     install/update only
  npx my-provider-dash-manager update      always fetch the newest release
  npx my-provider-dash-manager start       launch the installed app
  npx my-provider-dash-manager status      installed vs latest version, paths
  npx my-provider-dash-manager where       print install and data paths
  npx my-provider-dash-manager uninstall   run the uninstaller (keeps your data)

Flags: --silent  --interactive  --download-only  --force  --version  --help
Updates over an existing install run silently; first installs show the wizard.
Windows only. https://github.com/FiredMosquito831/my-provider-dash-manager`);
}

(async () => {
  if (flags.has('--help') || flags.has('-h') || cmd === 'help') return help();
  if (flags.has('--version') || flags.has('-v') || cmd === 'version') return console.log(pkgVersion());
  if (process.platform !== 'win32' && cmd !== 'status') {
    throw new Error('This app is Windows-only.');
  }
  switch (cmd) {
    case 'default': return install({ launchAfter: true });
    case 'install': case 'update': case 'upgrade': return install({ launchAfter: false });
    case 'start': case 'run': case 'launch': return launch();
    case 'status': return status();
    case 'where': case 'paths': return where();
    case 'uninstall': case 'remove': return uninstall();
    default: console.error(`Unknown command: ${cmd}\n`); return help();
  }
})().catch(err => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
