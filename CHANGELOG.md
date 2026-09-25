# Changelog

All notable changes to **Homepage GUI** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is the single source of truth for release notes — it is rendered both on
GitHub and inside the app (click the version in the sidebar footer → **About** → **Release notes**).

## Unreleased

## [0.4.1] - 2026-09-15

Documentation only — the app is unchanged from 0.4.0 apart from its version string.

### Changed
- **The README's install walkthrough now matches how setup actually works.** It said to get
  `HOST_CONFIG_DIR` exactly right before the first start, which 0.4.0 made unnecessary:
  - `.env` now explains that only `HOST_CONFIG_DIR` really matters and that a *parent* of
    the config directory works, since the wizard searches every mount — and that
    `HOMEPAGE_CONTAINER` is detected for you.
  - The "don't know your config path?" note shows the message and compose snippet the
    wizard prints, and the loop to follow: start it, read the host path, paste it in,
    recreate, **Scan again**.
  - "Start it" walks through all four wizard steps instead of summarising them in a line.
  - The Docker socket section covers both of its jobs — restarting Homepage *and* finding
    it — and what you lose without it.
- Documented the two dialogs 0.4.0 added: the connection picker behind the path in the
  header, and **About** behind the version in the sidebar footer.
- Corrected the backups section: with no explicit `BACKUP_DIR`, backups sit beside
  whichever `services.yaml` is in use rather than always in `/config`.
- Noted that existing installs never see the wizard, and where to find the file picker.

## [0.4.0] - 2026-09-15

### Added
- **The setup wizard now finds your `services.yaml` for you.** A new *Connect to Homepage*
  step lists every candidate it can find, says why each one turned up, and lets you confirm
  the right one — so a fresh install no longer depends on guessing `HOST_CONFIG_DIR`
  correctly before the first start. It looks in two independent places:
  - **Every folder mounted into the container** is walked for a `services.yaml`, ranked by
    whether Homepage's other config files (`settings.yaml`, `widgets.yaml`, `bookmarks.yaml`,
    …) sit beside it. The config directory can be mounted anywhere.
  - **Docker**, when its socket is mounted: the Engine API says which container is Homepage
    and which *host* directory it has bound to `/app/config`. Matched against the host
    directories bound into this container, that identifies the file exactly, and shows its
    host path next to the container path.
  - If Homepage's config directory isn't shared with this container yet, the wizard names the
    host path and prints the compose line to add — the one thing the old flow couldn't tell
    you. The scan starts as the wizard opens, so the step is ready by the time you reach it.
- **An About dialog**, opened by clicking the version in the sidebar footer: what this is,
  links to the project website, the source repository and Homepage itself, the release notes
  on demand, and the copyright and licence.
- **A Homepage connection dialog**, opened by clicking the path in the header. Same picker,
  for changing the file later, after a move, or on an install that predates the wizard. It
  also detects and sets the Homepage container name used by **Restart Homepage**.
- Both are backed by new endpoints — `GET /api/connection`, `GET /api/connection/detect`
  and `POST /api/connection` — and the choice is stored in `DATA_DIR/settings.json`, so it
  survives container recreates and needs no `.env` edit.

### Changed
- The configured path is now resolved per request instead of being frozen at import, so
  switching files takes effect immediately, with no restart.
- Backups follow the file: with no explicit `BACKUP_DIR`, they're written to
  `.homepage-gui-backups` beside whichever `services.yaml` is in use (unchanged for the
  default layout).
- `SERVICES_PATH` and `HOMEPAGE_CONTAINER` are now defaults rather than the last word — a
  choice made in the app takes precedence.
- A missing `services.yaml` opens the connection dialog instead of leaving an empty canvas
  behind an error toast.

### Fixed
- An unwritable or not-yet-created backup directory no longer stops the app from reading a
  config file it can otherwise open.

## [0.3.0] - 2026-09-15

### Fixed
- **Icons no longer break once Iconify rate-limits you.** The editor pointed `<img src>`
  straight at `api.iconify.design`, one request per icon. A single search in the icon
  picker fired ~130 of them, which trips Cloudflare's rate limit (error 1015) for the
  whole source IP for several minutes. The 429s come back as `text/plain`, Chrome's
  Opaque Response Blocking refuses to hand those to an `<img>`, and every preview
  silently fell back to `?` — the icon chip after picking, and the service cards.
  - Colouring an MDI icon looked *specifically* broken, because adding `-#hex` produces
    a URL that has never been cached, so it always went to the network and always got
    a 429 — while the uncoloured icon still rendered from browser cache.

### Added
- **Disk-cached icon proxy.** Iconify icon bodies, search results and the dashboard-icons
  index are now fetched by the app, sanitized, and cached under `ICON_CACHE_DIR`
  (defaults to a folder in `DATA_DIR`). Icons are requested in batches — one upstream
  call per prefix instead of one per icon — so a picker search costs a handful of
  requests rather than ~130, and a warm cache costs none at all. If upstream does
  rate-limit, the app honours `Retry-After`, keeps serving what it has, and says so
  instead of blanking every preview.
- Configurable with `ICON_CACHE_DIR` and `ICON_CACHE_MAX` (default 20,000 icons, ~8 MB).

### Changed
- Iconify icons render as inline `<svg>` rather than as `<img>`. They paint with
  `currentColor`, so the editor's colour control now applies instantly with **no**
  network request, and an uncoloured icon follows the theme instead of being black
  on a dark background.

## [0.2.0] - 2026-08-12

### Added
- **Sign-in, with a first-boot setup wizard.** A fresh install steers every request to
  `/setup`, where a three-step wizard creates the admin account (name, username, password)
  and signs you straight in. From then on every page and every `/api/*` route requires a
  session, and a **Sign out** button sits in the top bar.
  - One account, no registration page — this is a single-operator tool. Passwords are
    stored as werkzeug hashes in a small SQLite database; usernames match
    case-insensitively at sign-in.
  - The wizard's last step confirms which `services.yaml` the editor will write to and
    whether it's writable, so a bad mount surfaces before your first save.
- **Cloudflare Turnstile on the login (optional).** Set `TURNSTILE_SITE_KEY` and
  `TURNSTILE_SECRET_KEY` and the challenge renders on the sign-in page and is verified
  server-side before any password check. Leave either empty to skip it entirely; if
  Cloudflare is unreachable the login fails closed.
- **CSRF protection.** Every `POST`/`PUT`/`PATCH`/`DELETE` needs the per-session token,
  sent as a hidden `_csrf` field or an `X-CSRF` header; the editor's own API calls attach
  it automatically.

### Changed
- **BREAKING:** the app is no longer open to everyone who can reach the port. Existing
  installs will land on the setup wizard the first time they're opened after upgrading.
- New `DATA_DIR` (default `$HOMEPAGE_CONFIG_DIR/.homepage-gui`) holds the account database
  and the session signing key, so both persist across recreates with no extra volume.
  `SECRET_KEY` may be set to pin the signing key; otherwise one is generated and stored
  there. `services.yaml`, backups and uploaded icons are untouched.
- Sessions survive restarts, **Keep me signed in** issues a remember cookie, and signed-in
  HTML is served `Cache-Control: no-store` so it can't be replayed after signing out.
- `/api/health` stays reachable without a session for container health checks, but reports
  only `{"ok": true}` until you sign in.
- Added `Flask-SQLAlchemy`, `Flask-Login` and `requests` to requirements.

## [0.1.3] - 2026-07-04

### Changed
- Project moved to the **Hyprlab** organisation. All GitHub, Docker Hub, and in-app
  **Source** references now point to `hyprlab/homepage-gui`, and every remaining
  mention of the old name has been replaced with Hyprlab.
- Version reset to `0.1.3` under the new home.

## [1.1.2] - 2026-06-23

### Fixed
- Section **item-count pills** no longer wrap their label into a vertical stack when the
  section header is tight on space. The pill now stays on a single line and keeps its
  width in the flex header.

### Changed
- Slightly increased the vertical padding on the count pill so it reads as a proper pill
  rather than a thin sliver.

## [1.1.1] - 2026-06-17

### Fixed
- Icon color is now **opt-in** in the chooser. A default color was previously baked into
  every MDI / Simple Icons / SVG selection, overriding Homepage's default icon gradient.
  Selections now omit color unless **Apply color** is ticked, so `services.yaml` entries
  carry no color suffix/parameter when none is chosen.

### Changed
- Replaced the chooser's "None" color toggle with a clearer **Apply color** checkbox
  (unchecked by default).

## [1.1.0] - 2026-06-17

### Added
- **In-app release notes** — click the version in the sidebar footer to read this changelog
  inside the app (served from the same `CHANGELOG.md`).
- Exhaustive, Docker-Compose-focused README and a demo screenshot.

### Changed
- Compose host-path variables renamed to `HOST_CONFIG_DIR` / `HOST_ICONS_DIR` for clarity
  (they no longer collide with the container's `HOMEPAGE_CONFIG_DIR`).

## [1.0.0] - 2026-06-17

Initial public release.

### Added
- **Drag-and-drop editor** for Homepage's `services.yaml`: reorder sections, reorder
  services within a section, and move services between sections (SortableJS).
- **Sidebar** with a section navigator/filter and draggable "Service" / "Section" blocks
  that can be dropped onto the canvas or clicked to append.
- **Service editor** for name, icon, URL (`href`), description and `ping`, plus an
  **Advanced (YAML)** area that preserves widgets, `server`/`container` and any other keys.
- **Icon chooser** with combined and per-source search:
  - **All sources** — one search across every source below, with origin badges.
  - **Dashboard Icons** (`name.svg`), **Material Design Icons** (`mdi-`),
    **Font Awesome** (`fas-`/`far-`/`fab-`), and **SVG / freesvgicons** (Iconify, stored
    as a direct URL).
  - **My Uploads** — upload custom **PNG/SVG** icons, referenced as `/icons/<file>`.
- **Color overrides** for icons that support them (`mdi-`/`si-`/`sh-` via `-#hex`, and
  Iconify SVG URLs via `?color=`).
- **Alphabetical sort** per section (A→Z / Z→A toggle).
- **Timestamped backups** on every save/restore, with **14-day auto-purge** (configurable)
  and a count cap; restore or preview backups from the UI.
- **YAML preview** before saving, atomic writes, and validation that the generated YAML
  re-parses before it touches your file.
- **One-click Homepage restart** (via the Docker socket) so newly-uploaded icons are served.
- Self-hosted **Inter** font, cache-busted static assets, and an in-app **Source** link
  (AGPL §13).

[Unreleased]: https://github.com/hyprlab/homepage-gui/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/hyprlab/homepage-gui/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/hyprlab/homepage-gui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hyprlab/homepage-gui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hyprlab/homepage-gui/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/hyprlab/homepage-gui/compare/v1.1.2...v0.1.3
[1.1.2]: https://github.com/hyprlab/homepage-gui/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/hyprlab/homepage-gui/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/hyprlab/homepage-gui/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/hyprlab/homepage-gui/releases/tag/v1.0.0
