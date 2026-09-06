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
| v1 curated services | Vercel, Netlify, Supabase, Cloudflare, Railway, Render, GitHub |
| ToS stance | Warn on risky services (banner): Railway/GitHub are one-account-per-person by ToS; Vercel/Netlify/Supabase/Cloudflare watch multi-accounting |

## Architecture

- **Electron 43**, `BaseWindow` + one `WebContentsView` per open account tab (BrowserView and
  the `<webview>` tag are deprecated/discouraged).
- **One persistent session partition per account**: `session.fromPartition('persist:<service>:<account>')`.
  Each partition holds its own cookies (incl. HttpOnly), localStorage, IndexedDB, cache — fully
  isolated identities that survive restarts. Switching = activating another live view; sessions stay warm.
- **Hibernation lifecycle**: closing a tab destroys the view but keeps the partition on disk; reopening
  rehydrates from it (the Wavebox "sleeping tab" pattern). Bounds memory at many accounts.
- **OAuth/popup routing**: `setWindowOpenHandler` opens popups and OAuth windows inside a new view of the
  SAME account partition, so SSO state never leaks across accounts. Google OAuth is blocked in embedded
  browsers by Google policy — those flows must go through the system browser (planned: fallback button).
- **Chrome composition**: custom tab strip is the window's own page; dashboard views sit below it
  (`y = 44px`). Views get a synchronous background color and visibility-driven switching to pre-empt
  known Electron paint-order bugs (#43293/#47351); no draggable-region overlays on web content (#43320).
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

## Roadmap

1. **Memory spike (week 1)** — this repo now: automated Electron benchmark loading 5/10/20/30 real
   dashboard login pages in live vs hibernated partitions, plus restore-from-disk timing. Decides
   Electron-vs-WebView2 before shell investment. `npm run spike` → `spike-report.json`.
2. **Shell v1** — service rail + account tab strip + home grid of service×account tiles with session
   status; guided signup wizard per new account; "open in system browser" escape hatch on every tab;
   hibernation settings; per-account proxy (opt-in, advanced). UI design pass with `ui-ux-pro-max`.
3. **API layer** — optional per-account API tokens (safeStorage-encrypted, scoped, revocable from the app)
   powering home-screen status cards (deploys, project lists) and quick actions.
4. **Phase 2** — generic services (add any URL). 5. **Phase 3** — plugin manifests. Sync later.

## Memory spike results (Sept 7, 2026 — Electron 43, Windows 11, 64 GB RAM, login pages of all 7 services)

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
