# My Provider Dash Manager — multi-account manager for 37 cloud services

[![version](https://img.shields.io/github/v/release/FiredMosquito831/my-provider-dash-manager?label=version)](https://github.com/FiredMosquito831/my-provider-dash-manager/releases/latest)
[![npm](https://img.shields.io/npm/v/my-provider-dash-manager)](https://www.npmjs.com/package/my-provider-dash-manager)
[![downloads](https://img.shields.io/npm/dm/my-provider-dash-manager)](https://www.npmjs.com/package/my-provider-dash-manager)
[![stars](https://img.shields.io/github/stars/FiredMosquito831/my-provider-dash-manager)](https://github.com/FiredMosquito831/my-provider-dash-manager)
[![licence](https://img.shields.io/badge/licence-source--available-green)](LICENSE)

**For freelancers, agencies and developers running client plus personal infrastructure:** one desktop
app for every account you own. Keep several Google, Microsoft, AWS, Vercel, Netlify, Cloudflare,
Supabase, GitHub, npm, Stripe, Gmail, Outlook and Proton Mail accounts (37 services built in, any
site by URL) signed in at the same time, each in a fully isolated session, and switch between them
instantly — the way a browser handles tabs, but built around *accounts* instead of pages.

<sub>Windows desktop app · Electron 43 · local-first · no telemetry, no account, no server ·
source-available licence: free for personal and commercial use</sub>

![Home — the account rail on the left, every account as a card, the installed version bottom-left](https://raw.githubusercontent.com/FiredMosquito831/my-provider-dash-manager/main/docs/screenshots/home.png)

Further down Home: the **Add an account** picker with every built-in service you are not using yet
(37 in total, or add any site by URL), the **Updates** panel with the installed version, and the
saved-login controls. Install with `npx my-provider-dash-manager` or straight from
[Releases](https://github.com/FiredMosquito831/my-provider-dash-manager/releases) — see [Install](#install).

![Home, scrolled down — the service picker grouped by category, the Updates panel and saved logins](https://raw.githubusercontent.com/FiredMosquito831/my-provider-dash-manager/main/docs/screenshots/services.png)

![A Gmail account open in the app, with back / forward / reload / dashboard and the address bar in the strip](https://raw.githubusercontent.com/FiredMosquito831/my-provider-dash-manager/main/docs/screenshots/navigation.png)

<sub>Screenshots use a demo profile with placeholder account names.</sub>

---

## Install

**Fastest — from the command line** (needs Node.js 18+):

```bash
npx my-provider-dash-manager
```

That downloads the newest installer from GitHub, verifies it is a real Windows executable, runs it,
and launches the app. Run the same command again later to update.

**Or download the installer** from
[Releases](https://github.com/FiredMosquito831/my-provider-dash-manager/releases) and run it.

The installer is not code-signed yet, so SmartScreen shows a warning the first time: choose
**More info → Run anyway**. The app installs per user under `%LOCALAPPDATA%\Programs` and creates
Start Menu and Desktop shortcuts. Your accounts, sessions and saved logins live in
`%APPDATA%\multi-acc-manager` and survive updates and reinstalls.

### Updating

Three ways, all ending in the same place:

- **Automatically, inside the app (default).** The app checks on startup and hourly. A newer release
  downloads in the background and installs silently, with no wizard, the next time you close the app;
  the rail badge bottom-left turns into **Restart to update x.y.z** if you would rather do it now.
  Turn **Auto-update** off in the Updates panel on Home and every step waits for a button press
  instead (Check, Download, Restart & update), with release notes and progress shown.
- **From the command line.** `npx my-provider-dash-manager` (or `mpdm update` if installed globally)
  updates an existing install silently and in place; add `--interactive` if you want the wizard.
  Close the app first, or the running copy keeps showing the old version until you restart it.
- **From the release page.** Run the newest installer; it upgrades in place.

The repository is public, so updates need no token or account.

### The CLI

The npm package is a small lifecycle CLI. Install it globally with `npm i -g my-provider-dash-manager`
and it is also available as `mpdm`:

| Command | What it does |
|---|---|
| `my-provider-dash-manager` | Install or update to the newest release, then launch |
| `… install` / `… update` | Install or update only |
| `… start` | Launch the installed app |
| `… status` | Installed version vs latest, plus where the app and your data live |
| `… where` | Print the install and data paths |
| `… uninstall` | Run the uninstaller (accounts and sessions are kept) |

Flags: `--silent` (no wizard on a first install), `--interactive` (wizard for an update), `--download-only`, `--force`, `--version`, `--help`.
From a checkout of this repository the equivalent is `npm run install:latest`.

### Run from source

```bash
npm install
npm start
```

---

## Why it exists

Every provider assumes you have exactly one identity. The moment you have a personal account and a
client account on the same service, the browser fights you:

| The usual pain | What this app does |
|---|---|
| Signing out of one account to reach another | Every account stays signed in, in its own storage partition |
| Juggling browser profiles, one window each | One window: providers on the left, open accounts as tabs on top |
| "Which account am I actually in right now?" | Every tab and rail row is colour-coded and labelled by account |
| Losing your workspace on restart | The open-tab set is remembered and restored |
| Re-typing passwords for the fifth account | Logins are captured per account and refilled automatically |
| Ads and blinding white dashboards | Built-in ad-blocking and dark mode, no extensions required |

It is not a browser and not a scraper. It is a **container for identities**: real dashboards, real
sessions, one place.

---

## Using it

1. **Add an account.** Click **Add account** at the bottom of the rail (or the `+` next to a provider
   you already use), pick the service from the searchable picker, name the account, then choose
   *Log in* or *Create a new account*. The service's real sign-in page opens inside that account's own
   isolated session.
2. **Sign in normally.** Google services sign in directly. On other sites use email/password or
   GitHub rather than "Continue with Google", which Google blocks inside embedded browsers; the
   **Browser** button finishes any stubborn flow in your system browser.
3. **Switch accounts** by clicking a tab or a rail row. Everything stays signed in.
4. **Browse.** While a tab is open the strip shows back, forward, reload, a back-to-dashboard button
   and an address bar. Type any address and press Enter to open it inside that account's session.
5. **Connect a token** (optional) via the link icon on an account to light up its status card.
6. **Import passwords** (optional) from Home → *Import from browser* or *Import CSV*.

Keyboard: `Ctrl+W` sleep tab · `Ctrl+Shift+W` sleep all · `Ctrl+Tab` cycle · `Ctrl+1…9` jump ·
`Esc` Home · `Alt+Left` / `Alt+Right` back / forward · `Ctrl+R` or `F5` reload · `Alt+Home` dashboard
· `Ctrl+L` address bar.

---

## Features

### Accounts and sessions

**Multi-account session isolation** — every account in its own Chromium partition:
- **Unlimited accounts per service.** Each account gets its own storage partition — separate
  cookies, localStorage, IndexedDB and cache. Accounts can never see each other's session.
- **Sessions persist across restarts.** Sign in once; you stay signed in (verified by an automated
  restart test that counts real cookies after relaunch).
- **Instant switching.** Active tabs stay warm, so switching is a visibility toggle, not a reload.
- **Warm-tab limit with sleeping.** Each live dashboard costs roughly 125 MB, so the app keeps a
  configurable number warm (default 5) and sleeps the rest. Slept tabs stay in the strip and resume on
  click. Measured: 5 tabs ≈ 1.0 GB, 10 ≈ 1.6 GB, all slept ≈ 0.35 GB (private memory, the figure Task
  Manager reports).
- **Tab session memory.** The set of open tabs is saved and restored on the next launch: recent ones
  come back warm, the rest asleep, and you land on Home.
- **Per-account proxy** (optional) with proper connection flushing.

### Layout and browsing
- **Left rail — your identities.** Providers you use, accounts nested underneath, each with hover
  actions: open, sleep, close, fill login, connect a token, manage. Collapse any provider. The
  installed version (or an update button) sits at the bottom.
- **Top bar — open tabs only,** with a filter box and group-by-provider with collapsible groups.
- **Home** is always one click (or `Esc`) away: every account as a card with live status, the service
  picker, the Updates panel and saved-login settings.
- **Browser controls** while a tab is open: back, forward, reload/stop, back-to-dashboard and an
  editable address bar. Navigation stays inside that account's session and accepts http/https only.

### Built-in services
Thirty-seven services ship ready to use, grouped by category. The rail and Home show only the ones
you have accounts on; everything else is one click away in the **Add account** picker.

| Category | Services |
|---|---|
| Hosting & deploy | Vercel, Netlify, Cloudflare, Railway, Render, Fly.io, Heroku, DigitalOcean |
| Databases | Supabase, Neon |
| Code & packages | GitHub, GitLab, npm, PyPI, Docker Hub, Hugging Face |
| Payments | Stripe |
| Google | Google Account, Gmail, Google Cloud, Firebase, Google Workspace Admin, Google Play Console, Google AI Studio |
| Microsoft | Microsoft Account, Outlook, Azure, Microsoft 365 Admin |
| Mail | Proton Mail, Zoho Mail, Fastmail, Yahoo Mail, Tuta Mail, iCloud Mail |
| Cloud | AWS |
| AI | OpenAI Platform, Claude Platform (Anthropic) |

Every login page is verified to load inside an isolated partition, landing on a host the credential
guard trusts (`npm run smoke:services`). Google sign-in was verified against Google's own flow and
works in the app. Anything else can be added by URL or as a plugin.

### Password manager with per-service import
- **Remembers logins you type** inside an account tab, bound to *that* account, so two accounts on the
  same service refill with different credentials.
- **Auto-fills sign-in pages** when it recognises one (toggleable), plus a manual fill action.
- **Manage logins** from Home → Saved logins → *Manage logins…*: every stored login grouped by
  service, with delete. No password is ever shown.
- **Choose which login fills:** when more than one matches a site the app asks instead of guessing,
  and your choice is remembered as that account's default (marked ★ in the manager).
- **Re-importing updates changed passwords** instead of silently keeping the old one.
- **Imports existing passwords** from installed Chromium browsers (Chrome, Edge, Brave, Vivaldi,
  Opera) or from a CSV exported by any browser, including Firefox.
- Encrypted at rest with Windows DPAPI. Passwords never reach the app's own UI process.
- **Origin-bound**: a login is tied to the account *and* the service's own domains. A password typed on
  another site reached from that tab (an OAuth hand-off, a look-alike page) is never captured as that
  account's login, and a saved password is never filled into a page outside the service's domains.

### API status
Paste a read-only API token into an account and its Home card shows live status: project, app,
repository or package counts and names for every built-in developer service except PyPI (whose tokens
are upload-only), latest deploy state on Vercel, account name plus charges/payouts state on Stripe.
The token field says which credential each service expects. Tokens are validated before being stored,
encrypted with DPAPI, revocable in one click, and never leave the main process.

### Automatic silent updates
- **Silent in-place updates** by default: downloaded in the background, installed without a wizard
  when the app closes or on **Restart & update**, relaunched on the new version.
- **Auto-update toggle** for people who want to press every button themselves.
- Version always visible in the rail; it becomes **Update x.y.z** / **Restart to update** as the
  release moves through found → downloaded.
- Updates panel on Home: installed vs latest, release notes, progress. Startup and hourly checks
  against the public release feed. The interactive installer is only for first installs.

### Built-in ad-blocking and dark mode
- **Ad-blocking** driven by EasyList (~52,000 blocked hosts plus generic cosmetic rules, refreshed
  weekly), applied per account partition. Main-frame navigation and sign-in infrastructure are never
  blocked. uBlock Origin cannot run inside Electron — its service worker needs browser APIs Electron
  does not expose — so this built-in blocker covers that need.
- **Dark mode** for every account tab, powered by Dark Reader's own engine: one toggle on Home
  applies it everywhere. Flipping it is instant — pages do not reload, so your scroll position and
  anything half-typed into a form is preserved. It runs Dark Reader inside each tab's isolated
  session, costing roughly 2 MB per open account. Dark Reader's browser extension cannot run in
  Electron (its background worker needs APIs Electron does not expose, and its content script
  would touch the page's own JavaScript), so the engine is bundled and driven directly.

### Extensibility
- **Add any service by URL** — it gets its own rail row and isolated per-account sessions.
- **Service plugins**: drop a small JSON manifest into `plugins/` (or install it from the UI) to
  define a service and, optionally, how to read its API for status cards.

### Multiple accounts and provider terms
The app surfaces each provider's stance instead of hiding it. GitHub and Railway allow one account per
person and the rail says so — use their organisations and workspaces instead. Vercel, Netlify,
Supabase, Cloudflare, Heroku and DigitalOcean tolerate separate accounts but watch for abuse; the
registries, GitLab, Fly.io, Neon, Google, Microsoft and the mail providers treat extra accounts as
ordinary; Stripe expects one per business. Account creation is always manual and guided; nothing is
ever automated, because automated signup violates several providers' acceptable-use policies.

---

## How it works

Each account is a `persist:<service>__<account>` Chromium partition rendered in its own
`WebContentsView`. The app window composes those views beside a native rail and tab strip, so the
chrome is always reachable. Account pages run sandboxed with context isolation, deny-by-default
permissions, and an isolated-world preload that handles login capture and filling without exposing
anything to the page.

State lives in `%APPDATA%\multi-acc-manager`: `accounts.json` (the registry), `session.json` (open
tabs), `settings.json`, `services.json` (custom services), `plugins/`, plus DPAPI-encrypted
`tokens.json` and `credentials.json`.

### Security posture, honestly

Cookies, tokens and saved passwords are encrypted at rest with Windows DPAPI, which protects against
another user on the machine, a stolen disk, and casual copying. It does **not** protect against
malware running as you — no desktop app can, which is why the app never masks device identity and
keeps API tokens scoped and revocable. Saved logins are additionally bound to the service's own
origins, so they cannot be captured from, or filled into, an unrelated site. The address bar accepts
http/https only. Nothing syncs anywhere: there is no server, no account and no telemetry.

---

## Requirements

- **Windows 10 or 11** (64-bit). The app is Windows-only today; macOS and Linux are not supported yet.
- About **350 MB** of memory with all tabs asleep, plus roughly **125 MB per live dashboard** and
  **2 MB per open account** when dark mode is on. A machine with 8 GB of RAM handles the default
  five warm tabs comfortably.
- **Node.js 18+ only for the `npx` route** — the app itself is a standalone Windows executable and
  needs nothing else installed.

## Frequently asked questions

**Can I be signed into two accounts on the same service at once?**
Yes. Each account gets its own Chromium storage partition, so both stay signed in simultaneously and
you switch between them like tabs. Nothing is ever signed out to reach the other.

**How much memory does an extra account use?**
Roughly 125 MB of private memory per live dashboard (the figure Task Manager reports), on a ~350 MB
baseline with everything asleep. The app keeps five tabs warm by default and sleeps the rest; slept
tabs stay in the strip and resume on click.

**Is it safe to store my passwords?**
Saved logins are encrypted with Windows DPAPI and bound to the account *and* the service's own
domains — a password typed on an unrelated page reached from a tab is never captured, and a saved
password is never filled into a page outside the service's domains. DPAPI protects against another
user on the machine, a stolen disk and casual copying; it does not protect against malware running as
you, which no desktop app can. Passwords never reach the app's own UI process.

**Does it work on macOS or Linux?**
Not yet — the app and its installer are Windows-only. The architecture is cross-platform, so other
operating systems stay open as future work.

**How do I import passwords from Chrome or Edge?**
Home → *Import from browser* reads installed Chromium browsers directly. Chrome 127 and newer lock
some entries with app-bound encryption that no other app can read; export those to CSV from the
browser and use *Import CSV* instead. Firefox always uses the CSV path. Re-importing updates
passwords you have changed.

**Why does SmartScreen warn me?**
The installer is not code-signed yet, so Windows shows a warning the first time. Choose **More info →
Run anyway**. Code signing is planned and removes the warning entirely.

**Can I add a service that is not on the list?**
Yes — *Add service by URL* gives any site its own rail row and isolated per-account sessions, and
JSON plugin manifests can define a service plus how to read its API for status cards.

**What happens to my accounts when I update?**
Nothing is lost. Accounts, sessions, saved logins and settings live in
`%APPDATA%\multi-acc-manager` and survive updates and reinstalls. Updates install silently in place
and relaunch the app.

## Compared to the alternatives

| Approach | What it gives you | What it does not |
|---|---|---|
| Separate browser profiles | Isolated sessions per profile | One window each, no single place to see every account, no per-account password management |
| Incognito / private windows | A throwaway session | Nothing persists — you sign in again every time, and juggling windows is manual |
| Other multi-account managers | Similar switching | Usually extension-based in a normal browser, so one crash or update can take every session with it |
| **This app** | One window, persistent isolated sessions, a password manager, ad-blocking, dark mode and silent updates | Windows-only, unsigned installer, and no Chrome Web Store extensions (Electron cannot run them) |

## Troubleshooting

- **SmartScreen warns on first run.** Expected while the installer is unsigned: **More info → Run
  anyway**.
- **A service will not load inside the app** (Google Cloud Console is a known case). Use the
  **Browser** button in the strip to open that page in your system browser — it keeps working from
  there, and the rest of the app is unaffected.
- **"Which account am I in right now?"** Every tab and rail row is colour-coded and labelled by
  account, and the tab strip shows the service and account name together. The active tab is
  highlighted; slept tabs are dimmed.

---

## Development

```bash
npm start              # run the app
npm run smoke          # sessions, registry, partitions, tab navigation (12 checks)
npm run smoke:restore  # sessions survive a restart (real cookies)
npm run smoke:tokens   # DPAPI round-trip + live fake-token rejection per provider (15)
npm run smoke:creds    # import, per-account recall/selection, defaults, encryption at rest (16)
npm run smoke:autofill # real page: form detection, fill, capture, origin guard (10)
npm run smoke:updates  # version comparison, silent-install mode, auto-update toggle, real release-feed check (11)
npm run smoke:services # every built-in login page loads inside an isolated partition (42)
npm run smoke:dark     # Dark Reader darkens a white page, stays out of the page's own JS, re-injects after navigation (9)
npm run capture        # screenshot the running shell (--capture-out, --capture-open svc::id, --capture-js)
npm run spike          # memory benchmark
npm run dist           # build the Windows installer locally
npm run install:latest # fetch and run the latest released installer
npm start -- --print-paths            # show the app name, version and data folder
npm start -- --open vercel::personal  # open an account on launch
```

The suite is 115 checks across eight modes. `MAM_USER_DATA=<dir>` points any command at an isolated
profile.

Releases are cut by pushing a `v*` tag: GitHub Actions checks the tag against `package.json`, builds
the NSIS installer, publishes the GitHub release with the update feed, and publishes the npm package
through npm trusted publishing (OIDC, with a provenance attestation — no tokens involved).

## Licence

Source-available, © 2026 FiredMosquito831 — see [LICENSE](LICENSE).

**Free to use, personally and commercially.** You may not modify or redistribute changed versions, or
present the work as your own. If you mention the app anywhere, credit the author and link this repo:

> My Provider Dash Manager by FiredMosquito831 —
> https://github.com/FiredMosquito831/my-provider-dash-manager
