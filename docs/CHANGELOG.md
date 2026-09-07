# Changelog

All notable changes. Format loosely follows Keep a Changelog.

## 0.2.3 — 2026-09-07

### Added
- **Update system with a real UI.** Home now has an Updates panel showing the installed version, the
  latest released version, the release notes, and when it last checked. Buttons: *Check for updates*,
  *Download <version>*, and *Restart & install*, with live download progress. Nothing downloads or
  installs on its own (`autoDownload` is off) — previously the app only fired a silent OS notification
  with no in-app surface at all.
- **Private-repository support for updates.** The release repo is private, so the release feed is not
  readable anonymously; the panel explains this and lets you store a GitHub token (encrypted with
  DPAPI, read access is enough) which is used for both the version check and the download. Setting
  `GH_TOKEN` in the environment works too. Making the repository public removes the need entirely.
- Version checks work when running from source as well (straight against the GitHub releases API), with
  the UI stating plainly that installing an update requires the packaged build.
- `npm run smoke:updates`: 9 checks covering version comparison, dev-mode capabilities, and a real
  release-feed check with an actionable error.
- **`npm run install:latest`**: pulls the newest published release and runs its installer, printing the
  version and release notes first. Supports `--silent` and `--download-only`, uses `GH_TOKEN` or your
  `gh` session for the private repo, and verifies the download is a real Windows executable (and the
  expected size) before launching it.

## 0.2.2 — 2026-09-07

Security and correctness release: a 30-agent adversarial review confirmed 22 findings against the
0.2.x code, four of them critical. All are fixed.

### Security
- **Saved logins are now origin-bound.** A password typed on any page reached from an account tab
  (an OAuth hand-off, an outbound link, a look-alike page) could previously be captured and stored as
  that account's login, then auto-filled into the real service. Capture now refuses credentials from
  origins outside the service's own domains.
- **Autofill and manual fill verify the page's live origin** before typing a password, and refuse with
  a clear message when the tab is on another site.
- Credential recall also checks host, so a stored login is never returned for an unrelated origin.
- Six origin-guard regression checks added to `smoke:autofill`.

### Fixed
- Turning ad-block off now reloads tabs so already-hidden page elements come back.
- A plugin could shadow a built-in service for API-token validation; provider lookup now follows the
  same precedence as the service list, and colliding plugin keys are rejected at install.
- Generic filter rules no longer apply to the dashboards this app manages (substring rules and
  cosmetic CSS are skipped there), and shared deployment apexes (vercel.app, pages.dev, onrender.com…)
  can never be blocked as a whole.
- Warm-tab limit no longer sleeps one tab too many while you are on Home.
- "Sleep all" no longer cascades through re-activations; session writes are debounced and flushed on quit.
- Escape returns to Home even when the dashboard page has keyboard focus.
- The "Open in browser" button was permanently hidden after the rail rework — restored.
- Rail and tab-strip collapse states are independent; the provider chevron rotates again.
- Force-dark and native dark are mutually exclusive (they double-darkened).
- Home no longer freezes its whole re-render while the warm-tab field has focus, the saved-login count
  updates after passive captures, missing services fail loudly instead of throwing from event handlers,
  and add-account errors are unwrapped like everywhere else.

## 0.2.1 — 2026-09-07

### Added
- **Phase 3 — service plugins**: JSON manifests in `<userData>/plugins` define a service (URLs, colour,
  multi-account policy) and can declare an `api` block that powers status cards generically. Install /
  remove / write-an-example from the UI; invalid manifests are reported, never fatal.

### Fixed
- **Release pipeline dropped the installer**: electron-builder created the GitHub release twice
  concurrently, so the .exe upload was lost (v0.2.0 shipped with only a blockmap). The workflow now
  pre-creates the release, then uploads artifacts explicitly and publishes.
- Artifact names are now space-free (`My-Provider-Dash-Manager-Setup-<version>.exe`): GitHub rewrites
  spaces to dots on upload, which desynced the name recorded in `latest.yml` and would have broken
  auto-update.
- Service keys are de-duplicated across built-in, user-added and plugin services (first wins), so two
  services can never share a partition namespace.

## 0.2.0 — 2026-09-07

### Added
- **Left account rail (persistent)**: providers listed vertically with collapse/expand, accounts nested
  under each, per-account actions on hover — open, sleep, close, fill login, connect token, manage.
  Includes a Home button, Status/Sleep footer actions, and an "Add service" button.
- **Top bar is now tabs-only**: filter box and group-by-provider toggle; grouped mode gets collapsible
  per-provider sections. Slept tabs stay in the strip (dimmed) and resume on click.
- **Tab session memory**: the open-tab set persists to `session.json` and is restored on the next
  launch — tabs up to the warm limit come back live, the rest asleep, and the app lands on Home.
- **Saved logins**: logins typed inside an account tab are remembered (encrypted with Windows DPAPI)
  and bound to that account, so each account on a service refills with its own credentials.
  Auto-fill on sign-in pages (toggleable), plus a per-account "fill login" action.
- **Password import**: direct import from installed Chromium browsers (Chrome, Edge, Brave, Vivaldi,
  Opera) by decrypting Login Data with the DPAPI-wrapped key, plus universal CSV import (works for
  Firefox and any browser). Entries locked by Chrome 127+ app-bound encryption are detected and
  reported with CSV guidance rather than failing silently.
- **Native ad-blocking** (uBlock-style): EasyList network rules (~52k hosts) with weekly refresh and a
  seed fallback, plus generic cosmetic filtering; per-partition, never blocks main frames.
- **Dark mode** (Dark Reader-style): nativeTheme dark so sites use their own dark theme, plus an
  optional force-dark inversion for sites without one.
- **Phase 2 — any service by URL**: user-added services get their own rail row and fully isolated
  per-account sessions, exactly like the built-in providers.
- Smoke suites: `smoke:creds` (import, per-account recall, encryption at rest) and `smoke:autofill`
  (real page, real preload: form detection, fill, capture on submit).

### Fixed
- **Left rail vanished when a tab opened**, making Home unreachable: account views spanned the whole
  content area. Views now start after the rail (x = RAIL_W).
- **Home was unreachable with several tabs open**: showing Home slept the active tab, which
  auto-activated the next one. Home now hides views and keeps tabs warm instead.
- Hidden rail action buttons no longer reserve layout space (account names stopped truncating).

## Unreleased

### Added
- **Home dock**: a dedicated ⌂ button in a fixed left dock — reachable from ANY state, including with tabs open (also Esc). Clicking it sleeps the active tab and returns to the account grid; the dock shows the active location.
- **API layer**: per-account API tokens (validated before storing, encrypted with Windows DPAPI via
  safeStorage, ciphertext-only on disk, revocable in-app) powering home-card status summaries —
  project counts and names for Vercel, Supabase, Netlify, Cloudflare, Railway, Render, GitHub; latest
  deploy state on Vercel. Auto-refresh on startup and every 5 minutes on the home screen, plus a
  manual refresh button. Tokens never leave the main process; the renderer receives summaries only.
  Netlify note surfaced in the UI: their PATs are full-scope (no read-only tier below Business).
- Release infrastructure: electron-builder NSIS installer config, GitHub Actions tag-triggered release
  workflow with publish, electron-updater auto-update checks in packaged builds. Repo:
  FiredMosquito831/my-provider-dash-manager.
- Shell v1 (in progress): service rail, account tab strip, home grid of service×account tiles.
- Account registry persisted to userData (`accounts.json`): accounts survive restarts with labels, identity colors, last sign-in state, per-account proxy.
- Warm-tab limit with LRU sleeping (default 5, adjustable) — live tabs cost ~350–375 MB each.
- Per-account actions: rename (label only, partition id never changes), per-account proxy (opt-in), delete account (wipes session data), "clear site data".
- Sign-in status detection: amber "!" when an account sits on its login page (conservative heuristic).
- Guided account flow: choose "Log in" or "Sign up" (opens the service's signup page inside the new account's isolated session).
- "Open in system browser" escape hatch for the active tab (Google OAuth / Turnstile fallback).
- Keyboard shortcuts: Ctrl+W sleep tab, Ctrl+Tab / Ctrl+Shift+Tab cycle tabs, Ctrl+1..9 jump to tab.
- Smoke tests: `npm run smoke` (fresh-session end-to-end) and `npm run smoke:restore` (restart persistence proof), isolated userData.

### Fixed
- **Interactive mode dead on arrival**: BaseWindow has no loadFile/webContents/ready-to-show — the chrome window is now a BrowserWindow (found by adversarial review; spike/smoke had masked it).
- **Chrome-page menu crash**: Menu.buildFromTemplate threw on an unlabeled first item, which also silently skipped every IPC registration ("No handler registered" errors).
- Home grid registry is now a live projection (was a startup snapshot): added accounts appear, deleted accounts vanish instead of resurrecting on click, renames/proxy/state update instantly.
- Modals were invisible/unreachable while any tab was active (account views paint above the chrome DOM) — views now hide via a set-modal-open handshake while a modal is open.
- target=_blank / OAuth popup URLs were silently dropped (create() dedupe) — they now load in-place in the same account's tab; non-http(s) popup schemes are denied.
- Sanitized-id collisions no longer silently alias two accounts onto one session (auto-uniquify with -N suffix); user-typed labels are kept as display names (were silently replaced by the sanitized id).
- Rail click on a service with only hibernated accounts now reopens the account instead of prompting to add a duplicate.
- Escaped all user-string interpolation in the chrome renderer (label/url XSS/corruption via innerHTML).
- open-external gated to http/https only; deny-by-default permission handlers on account partitions; clearStorageData uses the documented default (dead 'websql'/'domstorage' enum entries removed); teardown moved to 'close' with split try/catch (renderer leak on window close); SPA-aware sign-in heuristic (did-navigate-in-page); blank-label saves are blocked in the UI; add-account failures surface inline errors; warm-tab limit is now editable in the UI.
- Spike/smoke modes default to isolated temp userData and exit non-zero when another instance holds the lock; test junk from earlier spike runs removed from the real %APPDATA% profile.
- Partition naming: `persist:<svc>__<id>` (sanitized) — colons beyond the `persist:` prefix are unsafe as Windows directory names and were never proven to persist across restarts.
- Spike benchmark crash: `emitState` touched `window.webContents` when no UI page was loaded (benchmark mode).
- Spike methodology: added one-visible-tab measurement (hiding tabs reclaims ~nothing; hibernation is the real lever).

## 0.1.0 — 2026-09-07

### Added
- Research workflow (7 agents): engines, session isolation, existing tools, per-service auth/ToS, UX patterns, security model, completeness critique — findings distilled into DESIGN.md.
- Memory spike (`npm run spike`): automated Electron benchmark over 5/10/20/30 partitions of all 7 services, live vs one-visible vs hibernated, restore-from-disk timing → `spike-report.json`.
- Interactive prototype: multi-window single-shell with per-account partitions, tab switching, sleeping tabs, live memory readout.
- DESIGN.md: full architecture, security model, per-service facts, spike results, roadmap.
