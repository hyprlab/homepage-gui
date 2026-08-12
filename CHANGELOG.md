# Changelog

All notable changes to **Homepage GUI** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is the single source of truth for release notes — it is rendered both on
GitHub and inside the app (click the version in the sidebar footer → **What's new**).

## [Unreleased]

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

[Unreleased]: https://github.com/hyprlab/homepage-gui/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hyprlab/homepage-gui/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/hyprlab/homepage-gui/compare/v1.1.2...v0.1.3
[1.1.2]: https://github.com/hyprlab/homepage-gui/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/hyprlab/homepage-gui/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/hyprlab/homepage-gui/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/hyprlab/homepage-gui/releases/tag/v1.0.0
