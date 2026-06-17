# Changelog

All notable changes to **Homepage GUI** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is the single source of truth for release notes — it is rendered both on
GitHub and inside the app (click the version in the sidebar footer → **What's new**).

## [Unreleased]

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

[Unreleased]: https://github.com/viibeware/homepage-gui/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/viibeware/homepage-gui/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/viibeware/homepage-gui/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/viibeware/homepage-gui/releases/tag/v1.0.0
