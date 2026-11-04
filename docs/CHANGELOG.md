# Changelog

All notable changes. Format loosely follows Keep a Changelog.

## 0.13.2 — 2026-11-04

### Fixed
- **The top address-bar saved-login chip now opens its popover above the active website.** Account
  views are native child views that paint above the app's HTML, so the picker could be present in the
  DOM and still be invisible. It now hides the active page while the popover is open, restores the
  page on close, and supports closing and reopening. Verified with the actual chip: 3 rows open, page
  restores, 3 rows reopen.

## 0.13.1 — 2026-11-03

### Fixed
- **A leftover copy of an unreadable older login store is no longer written.** The 0.13.0 "could not
  read the old store" path kept a second copy of that store next to the new encrypted one; the review
  of the shipped code found that copy adds no recovery value on the machine it targets and gives
  backup/support tools one more place to grab the same passwords. The original file is still left
  byte-identical and the honest notice is unchanged — the copy is gone.
- **A damaged store file is reported as damage**, not quietly treated as an empty list.
- **The "key file missing" message now says re-import once** instead of suggesting you go looking for
  a key backup.
- New checks: the no-copy behaviour and the damaged-file report are both pinned in `smoke:creds`.

## 0.13.0 — 2026-11-03

### Fixed
- **Saved logins now survive every restart.** On some machines — this one included — Windows'
  credential encryption uses a key that is only valid inside the process that wrote it, so a store
  written before you quit could not be read after you relaunch. The app then showed an empty saved
  logins list everywhere: no auto-fill, no picker, no manager rows, on every account. The store is now
  encrypted with **AES-256-GCM** under a 32-byte key kept next to it in the app's own profile folder
  (the same place your sessions and cookies already live), so it has no per-process key and reads back
  identically after a restart, an update, or a crash. From now on saved logins survive every restart.
- **An older store that cannot be read is reported, not silently swallowed.** If a saved-login store
  written by an earlier version cannot be decrypted on your machine, the app says so plainly on the
  Home screen instead of showing an empty list that looks like "you never saved anything":
  *Saved logins from an older version could not be read on this machine (Windows per-process
  encryption quirk) — re-import once and they will survive every future restart.* The old file is left
  untouched on disk, and a re-import switches the store over by itself.
- **A damaged store is refused honestly.** A store whose contents fail their integrity check is now
  reported as unreadable (with the file left as it was) rather than being handed back as mangled
  passwords. Every write is atomic, so an interrupted save cannot leave a half-written store.

### Changed
- **One-time re-import for existing installs.** Logins saved by an earlier version on an affected
  machine are genuinely unreadable there, so the update cannot recover them. **Re-import your logins
  once** — *Import from browser* (including Firefox profiles), or *Import CSV* — and they are written
  in the new format. That is the last time you will need to: from then on they survive every restart.
  On machines where the old store *was* readable, the migration happens automatically on first launch
  and your logins, their ids and their ★ defaults are kept exactly as they were.
- The Saved logins panel now says **"encrypted with AES-256-GCM, survives restarts"** instead of
  naming Windows DPAPI, which no longer encrypts this store. API tokens are unchanged (still DPAPI);
  so are the account sessions and cookies.

Suite grows 179 → 188 checks: `smoke:creds` 56 → 65, including a **two-launch** check that starts the
app twice on one scratch profile, saves a login in the first and requires the second to list it. That
check fails on the old store code and passes on the new one — the regression proof for this bug.

## 0.12.1 — 2026-11-03

### Fixed
- **The key icon on an account row in the left rail was a dead indicator** — pressing it did
  nothing (the tooltip even said "open Manage to see them"). It is now a button: pressing it opens
  that account's logins window (the same one the gear opens), with Use / Copy on every row.

## 0.12.0 — 2026-11-03

### Added
- **Firefox passwords import directly — no CSV export needed.** The **Import from browser** window now
  lists every installed Firefox profile that has saved logins, right alongside the Chrome, Edge,
  Brave, Vivaldi and Opera rows, and imports it in one click. Nothing new to open: it is the same
  window, one more kind of row.
- **The Firefox reader runs entirely in the app.** Firefox's key database is decrypted with the
  primitives Node already ships, so there is no new dependency, no external `openssl` call and no
  change to the installer. The profile is opened read-only and nothing is ever written back to it.
- **Skipped rows are counted, never silently dropped.** Two kinds of saved login can't become a
  usable entry: ones with no username (nothing to fill), and ones saved for a non-web page such as
  `chrome://settings` (a host that could never match a real site). Both are counted and the result
  line says how many.

### Changed
- **D12 corrected: modern Firefox is AES, not the old 3DES work.** The backlog assumed Firefox's NSS
  needed ASN.1/3DES effort with little payoff. On Firefox 63 and later the profile is PBES2 —
  PBKDF2-HMAC-SHA256 with AES-256-CBC — and the only unusual details are that Firefox stores a
  14-byte IV (rebuilt as `04 0e || <iv>`) and feeds `SHA1(globalSalt || password)` to PBKDF2. That
  made a small, dependency-free reader practical, which is what shipped here.
- **The import window's note no longer says Firefox is CSV-only.** It now states what actually
  happens: Firefox profiles are read directly, with the two exceptions below.

### Known limitations
- **A profile with a master password is refused, not prompted for.** The window says so plainly
  ("this Firefox profile has a master password set — export CSV from Firefox instead") and imports
  nothing. Asking for the password would mean a new prompt and a new failure surface; almost no
  profile sets one. **Named gap:** the refusal is proven, the prompt path does not exist in 0.12.0.
- **Firefox 62 and earlier (the old key format) is a hard refusal**, with the same "export CSV from
  Firefox" advice. The old generation cannot be tested here, so it is not decoded rather than
  silently skipped — a silent skip would read as data loss.
- A profile whose key database is damaged fails with an honest "master password or damaged" message
  rather than importing zero rows and looking successful.

Suite grows 173 → 179 checks: `smoke:creds` 50 → 56.

## 0.11.0 — 2026-11-03

### Added
- **Per-account ad-block and dark-mode overrides.** Ad-block and dark mode were app-wide only. Every
  account's **gear window** ("Manage account") now carries one control per feature with three
  choices: **Follow the app-wide setting** (the default — nothing changes until you touch it),
  **Always on for this account**, or **Always off for this account**. Under each choice the window
  says in words what the account actually resolves to ("Following the app-wide setting — currently
  on"), so the third state can never be confusing.
- **Overrides work in both directions.** An account's override *replaces* the app-wide toggle for
  that account: an account can keep blocking ads or stay dark while the app-wide toggle is off, and
  can be exempted while it is on. The gear window states this plainly.
- **It applies at once, with no reload — except one case.** Changing dark mode or turning ad-block
  *on* takes effect in the account's open tab immediately, in place. Turning ad-block **off** reloads
  that one tab, because the hidden-ad style injected into the page can only be removed by reloading.
  Changing the app-wide toggle now reloads only the tabs whose *effective* value actually changed,
  so an account that overrides a control is never reloaded by a change that does not affect it.
- **A "content: custom" marker** on the Home card of any account that overrides a content setting,
  so the exceptions are visible without opening each gear window.

### Changed
- Changing the app-wide **Ad-block** toggle no longer reloads every open tab: it reloads only the
  tabs whose resolved value fell to off. With no overrides set, that is exactly the same set of tabs
  as before.
- `npm run smoke:dark` grows from 9 to 26 checks: the first ad-block coverage in the suite (a
  network-free `ERR_BLOCKED_BY_CLIENT` vs `ERR_NAME_NOT_RESOLVED` discriminator), per-account dark
  and ad-block checks in both directions, live-flip checks, the sparse-storage and byte-identity
  contracts, and IPC validation. Suite total 156 → 173.

## 0.10.1 — 2026-11-03

### Fixed
- **The 0.10.0 smoke check for clipboard copy was false-red on cold runs.** On the day's first
  suite run the two `smoke:creds` copy checks could fail even though the copy itself succeeded:
  the check read the clipboard back once and lost the race with Windows' clipboard settling. The
  check now polls the read-back (2.5 s, one retry) after the required warm-up write. No product
  behaviour changed; the copy feature itself was never affected.

## 0.10.0 — 2026-11-03

### Added
- **A saved-logins picker for the site you are on.** A small key chip now sits right of the address
  bar and counts the saved logins that can sign you in on the page's current site — "🔑 3" — so you
  see them on any sign-in page, not only when auto-fill happens to fire. Click it for a list with a
  **search box** (by username or site) and, on each row, **Use** (fills the email and password fields
  and makes it that account's default, with the usual Undo banner), **Copy email** and **Copy
  password**. The chip refreshes as you navigate and shows nothing when the site has no saved logins.
- **Shared imported logins are visible on every site they match.** The picker lists this account's
  own saved logins *and* every imported login whose site matches the page — so an import done once
  shows up on that service's login pages in every account, which is what "all my passes for this
  site" means. Imported rows say where they came from; rows saved for this account say so.
- **Copy never reveals.** Copy email and Copy password put the value on the Windows clipboard
  straight from the app's secured process. The password is never displayed, and it is never sent to
  the window that draws the interface — copying is refused unless the tab is actually on that
  login's own site.

### Changed
- The picker is scoped to one account and one live site: another account's saved login is not
  listed and cannot be copied from here (a saved login belongs to the account that made it).

## 0.9.0 — 2026-11-03

### Added
- **Each account now shows its own saved logins.** Every account's **Manage** (gear) window has a
  *Saved logins for this account* list — the logins that actually belong to it (the ones you saved
  while signed in there, plus imported ones for that service), with the ★ on the account's default
  and a **Use** button that makes that login the account's default and fills it into the open tab.
  The rail row shows a small key next to any account that has a saved login, so you can tell while
  the tab is asleep. Passwords are still never displayed or sent to the window — the list is
  username, site and source only.
- **Auto-fill now tells you what it did.** When a sign-in page is filled automatically, a banner
  appears above that account's page: "Filled <user> into this page" with **Undo** (clears exactly
  what was filled, and nothing you typed yourself) and a dismiss button. When several saved logins
  match a site the app no longer silently does nothing — the same banner offers the chooser.
- **"Never auto-fill for this account"** switch in the account's Manage window. Default off. It only
  ever *removes* auto-fill for that account; the app-wide **Auto-fill** toggle on Home stays the
  master switch, and manual **Use** / the rail key are always available.
- **The saved-logins manager was rebuilt.** It is wider (560 px), every login is a proper row with
  the identity on the left, the default control in a fixed column and the actions on the right, so
  the buttons no longer float beside tall rows and long usernames are no longer cut off. Filter with
  chips: **All**, any service, or any single account, and set or clear an account's default from the
  row itself.

### Changed
- A manual fill no longer fails silently. Filling now works from a dashboard too: when the page you
  are on has no saved login of its own, the account's logins for that service are used (still only
  ever on the service's own domains — a fill on any other site is refused). When a fill cannot
  happen, the banner says why ("no sign-in form is visible on this page", "no saved login for this
  account yet") instead of an alert box.

### Fixed
- **"Clear default" actually clears.** Choosing it used to set a default instead of clearing the
  existing one.
- The ★ markers can no longer get out of step with what is stored: the manager now re-reads the list
  from the app after each change instead of patching its own copy.

## 0.8.0 — 2026-10-15

### Added
- **Dark mode that actually works, powered by Dark Reader's own engine.** The old "Dark sites" hint
  and the crude "Force dark" invert filter are replaced by Dark Reader (v4.9.133, MIT). It is *not*
  loaded as a browser extension — Dark Reader's extension cannot run correctly in Electron (its
  background worker crashes on APIs Electron does not expose, and its content script would touch
  the page's own JavaScript, breaking the account-view isolation guarantee). Instead Dark Reader's
  self-contained API build runs inside each tab's **isolated world**, where it can darken the page
  but the page's own JavaScript can never see it. One **Dark mode** toggle on Home applies it
  everywhere, instantly — no reload, so scroll position and half-typed form contents survive. Roughly
  2 MB per open account (the extension approach measured ~25 MB per partition).
- **A real password manager.** Home → Saved logins → *Manage logins…* lists every stored login
  grouped by service, with delete. When more than one login matches a site the app **asks which to
  fill** instead of silently picking one, and your choice is remembered as that account's default
  (marked ★ in the manager). Re-importing from a browser or CSV now **updates changed passwords**
  instead of keeping the stale one.
- **SEO:** a landing page at `docs/index.html` published to GitHub Pages (meta tags, Open Graph,
  Twitter card and JSON-LD `SoftwareApplication`), `robots.txt` + `sitemap.xml`, a 1280×640 social
  preview card, a keyword-rich repository description and 20 topics, and README images switched to
  absolute URLs so they render on npmjs.com too.

### Changed
- The two dark-mode buttons ("Dark sites", "Force dark") are one **Dark mode** button.
- Ad-blocking stays the built-in EasyList blocker. uBlock Origin and uBlock Origin Lite were tested
  and **cannot work** in Electron: their service worker dies on APIs Electron does not expose
  (`chrome.permissions`, `chrome.commands`), so nothing blocks. Both are also GPL-3, incompatible
  with this app's licence.

### Fixed
- Collapsing a provider group in the top strip no longer collapses the wrong thing in the rail (the
  scope argument was dropped at the IPC bridge).
- Autofill no longer hands one account's saved password to a *different* account of the same service.
- A generic ad-block substring rule can no longer block a resource on your own `*.vercel.app` /
  `*.pages.dev` deployment.
- Changing a password in your browser and re-importing no longer leaves the stale password in place.
- Deleting an account now removes its saved logins, so a re-created account with the same name never
  inherits the old one's password.
- The open-tab set is flushed to disk when the window closes, so closing a tab and quitting
  immediately no longer resurrects it on the next launch.
- Login capture ignores Enter/click on pages that merely *contain* a password box (change-password
  and settings pages), not just real sign-in submits.
- Home no longer scrolls back to the top when a background tab finishes loading.

## 0.7.0 — 2026-09-07

### Added
- **Automatic, silent updates.** New releases now download in the background and install silently
  (no installer wizard) either when you close the app or when you press **Restart & update**. The
  app relaunches on the new version. An **Auto-update** toggle in the Updates panel turns this off,
  which restores the old press-a-button-for-each-step flow. The interactive installer wizard is only
  ever shown for a first install.
- The rail badge reads "Restart to update x.y.z" once an update is downloaded.
- `npx my-provider-dash-manager` / `mpdm update` now update an existing install silently and in
  place; `--interactive` brings the wizard back, and first installs still get the wizard.

### Changed
- "Restart & install" is now "Restart & update" and no longer opens the installer wizard.

## 0.6.3 — 2026-09-07

### Changed
- README: a third screenshot showing the service picker, Updates panel and saved-login controls,
  with the install routes (npx or the release page) called out next to it.

## 0.6.2 — 2026-09-07

### Changed
- README rewritten: install and the three ways to update up front, the CLI table, a walkthrough,
  the full feature list and services table, two current screenshots. Stale screenshots of the old
  layout removed.

## 0.6.1 — 2026-09-07

### Added
- **Version badge in the rail footer.** The installed version is always visible bottom-left; when a
  newer release exists it turns into an "Update X.Y.Z" button. Clicking it jumps to the Updates panel
  on Home (which previously sat below the fold once you had a few accounts).

## 0.6.0 — 2026-09-07

### Added
- **Browser controls for the open tab.** Back, Forward, Reload/Stop, a "back to dashboard" button and
  an editable address bar sit in the top strip whenever a tab is active. Type an address and press
  Enter to go there inside that account's own session (http/https only; a bare `example.com` becomes
  https). Shortcuts: `Alt+Left` / `Alt+Right`, `Ctrl+R` or `F5`, `Alt+Home` for the dashboard,
  `Ctrl+L` to focus the address bar. `Esc` inside the address bar restores it instead of going Home.
- Eight navigation checks in `npm run smoke` (scheme rejection, address navigation, back, dashboard).

### Changed
- The View menu's Reload entries, which only ever reloaded the app chrome, are replaced by the
  Navigate menu that acts on the active account tab.

## 0.5.0 — 2026-09-07

### Added
- **Google, Microsoft, mail, AWS and AI services** — 20 new built-ins, 37 in total: Google Account,
  Gmail, Google Cloud, Firebase, Google Workspace Admin, Google Play Console, Google AI Studio;
  Microsoft Account, Outlook, Azure, Microsoft 365 Admin; Proton Mail, Zoho Mail, Fastmail, Yahoo
  Mail, Tuta Mail, iCloud Mail; AWS; OpenAI Platform and Claude Platform (Anthropic).
- **Google sign-in works inside the app.** Verified against Google's own sign-in flow: with the
  app's default browser identity Google serves its sign-in and looks the account up. (Do not expect
  "Continue with Google" on third-party sites to work — Google blocks that in embedded browsers.)
- **Add-account picker.** The rail and Home now show only services you have accounts on; every other
  service is one click away in a searchable, category-grouped picker. A fresh install shows the
  picker on Home instead of 37 empty rows.

### Changed
- Sign-in detection understands services that authenticate on a separate host (accounts.google.com,
  login.live.com, id.heroku.com…).
- The ad-blocker leaves sign-in infrastructure alone (Google's session-check iframe, Microsoft and
  Apple login CDNs); those hosts get no password trust.
- Services' sign-in domains are declared explicitly where they differ from the dashboard (Microsoft,
  Apple, Zoho EU, AWS regional sign-in, OpenAI's auth host, Anthropic's old console domain).
- The Anthropic entry follows the console's move to platform.claude.com.

## 0.4.1 — 2026-09-07

### Changed
- Releases publish to npm through npm trusted publishing (OIDC) with a provenance attestation. No
  publishing token is stored anywhere any more.

## 0.4.0 — 2026-09-07

### Added
- **Ten new built-in services**: Fly.io, Heroku, DigitalOcean, Neon, GitLab, npm, PyPI, Docker Hub,
  Hugging Face and Stripe — 17 in total, now grouped in the rail as hosting, data, code & packages,
  and payments. Each gets isolated per-account sessions, guided login/signup, saved-login capture and
  fill, and (except PyPI, whose tokens are upload-only) an API status card.
- **Status cards** for the new services: apps on Fly.io, Heroku and DigitalOcean (droplets + App
  Platform), projects on Neon and GitLab, packages on npm, repositories on Docker Hub, models on
  Hugging Face, and account name with charges/payouts state on Stripe.
- The token field now says which credential each service expects (e.g. Docker Hub needs
  `username:token`; Stripe wants a restricted read key).
- `npm run smoke:services`: checks every built-in definition and loads each login page inside an
  isolated partition, asserting it lands on a host the credential guard accepts (21 checks).
- `smoke:tokens` now proves every new provider rejects a fake token cleanly (15 checks).

### Changed
- Services that authenticate on a separate domain (Docker Hub → `login.docker.com`) declare it
  explicitly, so saved logins are captured and filled there but nowhere else.

## 0.3.1 — 2026-09-07

### Changed
- Releases now publish the npm package automatically: the `NPM_TOKEN` secret is configured, so a
  single `v*` tag ships the GitHub release **and** the npm package with no manual step.

## 0.3.0 — 2026-09-07

### Added
- **Published to npm as `my-provider-dash-manager`.** `npx my-provider-dash-manager` installs (or
  updates) the app and launches it — no checkout required.
- **A real CLI** behind that package, also available as `mpdm`: `install`, `update`, `start`,
  `status` (installed vs latest, plus app and data paths), `where`, `uninstall`, with `--silent`,
  `--download-only` and `--force`. It skips the download when you are already on the latest version.
- **Releases now publish to npm as well as GitHub.** The workflow refuses a tag that disagrees with
  `package.json`, skips npm if that version is already published, and warns loudly if the `NPM_TOKEN`
  secret is missing rather than silently shipping only half a release.

### Fixed
- The CLI compares versions correctly: Windows reports a four-part product version (`0.2.3.0`) against
  a three-part release version (`0.2.3`), which would otherwise never match.

## 0.2.8 — 2026-09-07

### Fixed
- **Corrected the documented memory cost.** The README and DESIGN quoted 350–375 MB per live dashboard,
  which came from the over-reporting working-set metric. Re-measured with private memory: **~125 MB per
  live dashboard** on a ~370 MB baseline (5 tabs ≈ 1.0 GB, 10 ≈ 1.6 GB, all slept ≈ 0.35 GB).

### Changed
- README: install via `npx my-provider-dash-manager`, plus the `--print-paths` and `--open` flags in the
  development commands.

## 0.2.7 — 2026-09-07

### Changed
- Package renamed to **my-provider-dash-manager** (matching the repository and the app) and prepared
  for npm: a `bin` entry means `npx my-provider-dash-manager` fetches and runs the latest installer.
- The user-data folder is **pinned to the original location**, so the rename cannot orphan existing
  accounts, sessions or saved logins.

### Added
- `--print-paths` prints the app name, version and data folder — useful for support.

## 0.2.6 — 2026-09-07

### Fixed
- **Memory readout was roughly 1.7× too high.** It summed each process's working set, which counts
  Chromium's shared pages once per process — 1,388 MB reported where Windows showed 803 MB private for
  the same instant. It now reports private memory, matching Task Manager, with the working-set total
  in the tooltip.

### Changed
- The repository is public under a source-available licence (free personal and commercial use, no
  modification or derivative distribution, attribution required). Updates therefore need no token.

## 0.2.5 — 2026-09-07

### Changed
- Update checks now run **hourly** (was every four hours), still on startup as well. The Updates panel
  and its Check / Download / Restart & install buttons are unchanged.
- README restructured: **Install** now sits directly under the introduction, ahead of the screenshots.

## 0.2.4 — 2026-09-07

### Added
- README screenshots taken from a demo profile with placeholder account names: the Home grid with the
  account rail, a real dashboard running inside the shell, the grouped tab strip, and the
  Updates / Saved-logins panels.
- Screenshot tooling: `--capture-out/--capture-open/--capture-scroll/--capture-js`, a separate
  view-layer capture (native child views never appear in a window capture), `scripts/shot.ps1`
  (PrintWindow, so it can only ever capture this app) and `scripts/composite.ps1`.
- `--open <service>::<account>` opens and focuses an account at startup.

### Fixed
- The tab strip could overflow into the memory readout when many tabs were open.

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
