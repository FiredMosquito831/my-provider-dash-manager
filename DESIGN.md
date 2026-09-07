# multi-acc-manager — Design

A Windows desktop app to create and manage multiple accounts per cloud/dev service
(Vercel, Netlify, Supabase, Cloudflare, Railway, Render, GitHub) with one dashboard per
service, one tab per account, instant switching, and sessions that persist across restarts.

## Decisions (agreed with product owner, Sept 2026)

| Decision | Choice |
|---|---|
| Primary interaction | **Webview-led hybrid**: real embedded dashboard tabs per account are the product; API-token status cards on the home screen and other API-powered extras layered on top |
| Platform | Windows desktop app (cross-platform stays open; Electron gives it for free) |
| Account creation | Guided **manual** signup inside each account's own isolated session — never automated (Vercel/Netlify AUP prohibit automated multi-account creation; Cloudflare detects bulk signup) |
| Service set growth | Phase 1: curated built-in list done well → Phase 2: fully generic (any URL) → Phase 3: plugin manifest ecosystem |
| Sync | Single machine first, encrypted local store; multi-device sync documented as a future option |
| Curated services | v1: Vercel, Netlify, Supabase, Cloudflare, Railway, Render, GitHub. 0.4.0 added Fly.io, Heroku, DigitalOcean, Neon, GitLab, npm, PyPI, Docker Hub, Hugging Face, Stripe (17 total) |
| ToS stance | Warn on risky services (banner): Railway/GitHub are one-account-per-person by ToS; Vercel/Netlify/Supabase/Cloudflare watch multi-accounting |

## Architecture

- **Electron 43**, a `BrowserWindow` for the chrome + one `WebContentsView` per open account tab
  (BrowserView and the `<webview>` tag are deprecated/discouraged). `BaseWindow` cannot be used for
  the chrome: it has no `loadFile`/`webContents`/`ready-to-show`.
- **One persistent session partition per account**: `persist:<service>__<sanitized-account>` (no colons
  beyond the prefix — they become unsafe directory names on Windows).
  Each partition holds its own cookies (incl. HttpOnly), localStorage, IndexedDB, cache — fully
  isolated identities that survive restarts. Switching = activating another live view; sessions stay warm.
- **Hibernation lifecycle**: sleeping a tab destroys the view but keeps the partition on disk *and*
  keeps the tab in the strip so it can be resumed; closing removes it from the set. The open-tab set is
  persisted to `session.json` and restored on launch (warm up to the limit, land on Home).
- **OAuth/popup routing**: `setWindowOpenHandler` loads popup/OAuth URLs inside the SAME account's tab
  and partition, so SSO state never leaks across accounts. Because that lets a tab reach any origin,
  credential capture and fill are origin-guarded (see Security invariants). Google OAuth is blocked in
  embedded browsers by Google policy — the "Browser" button hands those flows to the system browser.
- **Chrome composition**: the window's own page renders a 48px top strip (open tabs only) and a 240px
  left rail (providers → accounts → actions); dashboard views are positioned at `x = 240, y = 48` so they
  can never cover the chrome. Views get a synchronous background colour and visibility-driven switching
  to pre-empt Electron paint-order bugs (#43293/#47351); no draggable-region overlays (#43320).
- **Security model (honest)**: partition cookie DBs are AES-GCM encrypted at rest with a DPAPI-wrapped key
  (protects against other users / stolen disk, NOT same-user malware); app secrets go through
  `safeStorage` (async, Electron 42+); no cloud sync of partitions; encrypted-ciphertext-only export when
  it ships; per-account "clear all site data" = `clearStorageData`. Security page in-app will state the
  threat model plainly.
- **Engine fallback**: WebView2 named profiles (one UDF, N profiles, one browser process) is the verified
  Windows fast path if Electron memory proves unacceptable — decide after the memory spike, not before.
- **Watchlist**: tauri#9285 (stable Tauri multiwebview), Electron #24573 (passkey umbrella), Chromium 2-week
  release cadence (from Sept 2026) → pin Electron 43.x, budget quarterly upgrades + repaint regression tests.

## Service registry

A service is config (`src/services.js`): key, name, dashboard/login URLs, brand color,
`multiAccountPolicy: 'ok' | 'warn' | 'one-per-person'` driving warning banners. Phase 2 makes this
user-creatable; Phase 3 turns it into a manifest format others can author.

Per-service facts that shaped the design:
- **Cloudflare**: dashboard sessions expire after 72h idle; re-auth from a new IP needs an email
  one-time code → "session expired, check email" is a first-class per-account state.
- **Supabase**: 2 free projects per user total; orgs unlimited; most fragile auth (Cloudflare-fronted,
  phantom-MFA bugs) → canary service for session-restore testing.
- **GitHub / Railway**: one account per person by ToS (enforced) → surface workspace/org switching under
  one login; warn on extra accounts. GitHub 2FA permanently un-disableable since Sept 2026.
- **Vercel**: email-only accounts demand OTP at every login → prompt to link a Git provider at setup.
- **Render**: up to 5 free Hobby workspaces under one login = compliant multi-tenancy.

## Module map (as of v0.2.3)

| File | Responsibility |
|---|---|
| `src/main.js` | App lifecycle, ViewManager (tabs, partitions, session memory, warm-limit LRU), the credential origin guard, all IPC, smoke/spike/capture modes |
| `src/ui.html` / `src/ui.js` | The chrome: left account rail, tabs-only top strip, Home grid, modals, Updates panel. Plain DOM, no framework |
| `src/preload.js` | contextBridge surface for the chrome renderer |
| `src/account-preload.js` | Isolated-world helper inside every account view: login capture, fill on request, login-form detection. Exposes nothing to the page |
| `src/services.js` | The 17 curated built-in services: URLs, colour, multi-account policy, optional extra auth hosts trusted by the credential guard, token hint |
| `src/providers.js` | Read-only API status fetchers per built-in service |
| `src/api-tokens.js` | DPAPI-encrypted token store (`safeStorage`), validated before storing |
| `src/credentials.js` | Saved logins: encrypted store, Chromium/CSV import, per-account + per-origin recall |
| `src/content.js` | EasyList ad-blocking (per-partition `webRequest`), cosmetic CSS, dark mode |
| `src/plugins.js` | Service manifests: validation, load/install/remove, generic API status provider |
| `src/updater.js` | Version tracking, release info, explicit download/install, private-repo token support |
| `scripts/install-latest.js` | `npm run install:latest`: pull the newest release and run its installer |

### Security invariants (do not regress)

1. A saved credential is bound to **account AND origin**. Capture rejects foreign origins; recall
   requires a related host; fill checks the tab's *live* URL. (D14 — this was a real vulnerability.)
2. Account views are sandboxed, context-isolated, deny-by-default on permissions, and never receive
   a preload that exposes anything to page JavaScript.
3. Tokens and passwords never leave the main process; the renderer sees summaries and booleans only.
4. Account views are positioned at `x = RAIL_W, y = TAB_STRIP_H` so they can never cover the chrome.
5. Generic filter rules are not applied to managed dashboards, and deployment apexes are never blocked.


## Roadmap

Phases 1–3 are **delivered** (curated services → any-URL services → plugin manifests), along with the
API-token layer, saved logins, content blocking and the update system. The memory spike that decided
Electron-vs-WebView2 is recorded below. Remaining work lives in `docs/BACKLOG.md`; the near-term items
are per-account content settings, direct Firefox password import, and code signing.


## Memory spike results

**Note on the metric.** The first spike summed each process's *working set*, which counts Chromium's
shared pages once per process and over-reports by roughly 1.7× (verified against Windows: 1,388 MB
working set vs 803 MB private for the same 10 processes). The app and these figures now use **private
memory**, which is what Task Manager shows.

### Corrected measurements (private memory, Sept 7 2026)

| Live tabs | Private | Working set (for reference) |
|---|---|---|
| 5 | 993 MB | 1,952 MB |
| 10 | 1,613 MB | 3,764 MB |
| all slept (after 10) | 339 MB | 564 MB |

Marginal cost ≈ **125 MB per live dashboard**, on a ~370 MB shell baseline. Sleeping returns the app to
that baseline, which is what makes the warm-tab limit effective.

### Original working-set run (Sept 7, 2026 — Electron 43, Windows 11, 64 GB RAM, login pages of all 7 services)

| Live tabs | All visible | One visible | Hibernated |
|---|---|---|---|
| 5 | 1,979 MB | 1,957 MB | 498 MB |
| 10 | 3,620 MB | 3,620 MB | 726 MB |
| 20 | 7,549 MB | 7,482 MB | 1,039 MB |
| 30 | 10,700 MB | 10,699 MB | 1,339 MB |

- Marginal cost per live tab ≈ **350–375 MB** (these login pages are heavy SPAs; logged-in dashboards similar or heavier). Hiding a tab reclaims almost nothing — page stays in its renderer.
- Hibernation works: shell returns to ~0.5 GB + ~30–40 MB per hibernated account. The hibernated baseline grows with count — possible retained renderer/browser-process residue, worth one investigation before the shell build.
- Restore-from-disk: 30 partitions reopened in ~11 s, back to full footprint.
- **Decision: stay on Electron.** No WebView2 pivot needed. But the hibernation policy is core, not polish: keep a small number of tabs warm (configurable, default ~5), sleep the rest aggressively; instant-switch applies within the warm set. A "sleep all" and per-tab sleep are in v1 regardless.

## Open items

- Logged-in memory pass (optional, needs real accounts) — login-page numbers suffice for the engine decision; a logged-in run would refine the default warm-tab count.
- Railway/Render session-length behavior unverified; confirm in the logged-in pass.
- Investigate the growing hibernated baseline (~35 MB/account retained) for renderer leaks.
- Windows code signing (SmartScreen) before distribution.
