# Homepage GUI

A self-hosted, drag-and-drop editor for [Homepage](https://gethomepage.dev)'s
`services.yaml`. Organize sections and services, edit every field, pick or
upload icons, and save straight to your live dashboard. It runs in one
container, behind a sign-in you set up on first start.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Docker Image](https://img.shields.io/docker/v/hyprlab/homepage-gui?label=docker%20hub&sort=semver)](https://hub.docker.com/r/hyprlab/homepage-gui)
[![Docker Pulls](https://img.shields.io/docker/pulls/hyprlab/homepage-gui)](https://hub.docker.com/r/hyprlab/homepage-gui)

![Homepage GUI screenshot](https://raw.githubusercontent.com/hyprlab/homepage-gui/main/assets/screenshot.png)

## What it does

Homepage's `services.yaml` is hand-edited YAML: a list of sections, each with
services that carry an `icon`, `href`, `description`, `ping` and widgets.
Homepage GUI edits that file in the browser, on any device on your LAN, and
writes back to the same file Homepage reads, with a backup before every save.
Homepage reloads it by itself, so changes appear at once.

## Features

- **Drag and drop:** reorder sections and services, and move services between
  sections.
- **Full service editing:** name, icon, URL, description and `ping` as fields,
  plus an **Advanced (YAML)** panel that keeps widgets, `server`, `container`
  and any other keys intact.
- **Icon chooser** searching Dashboard Icons, Material Design Icons, Font
  Awesome and 200,000 Iconify SVGs at once, plus your own PNG and SVG uploads.
- **Icon colors** for the sources Homepage can recolor, with a color picker.
- **Safe saves:** the YAML is validated before writing, writes are atomic, and
  a timestamped backup is taken first. Restore any backup from the app.
- **Finds your config by itself:** the setup wizard scans every mounted folder
  for `services.yaml` and asks Docker where Homepage keeps its config, so you
  pick the file from a list instead of typing a path.
- **One-click Homepage restart** so new icon uploads are served.
- **Sign-in** with one admin account and optional Cloudflare Turnstile.

## Requirements

- Docker with Docker Compose v2.
- A Homepage install on the same host. You don't need to know where its config
  directory is; the setup wizard works that out.
- Internet access in the browser for icon search and previews. Editing and
  saving work offline.

## Install with Docker Compose

```bash
git clone https://github.com/hyprlab/homepage-gui.git
cd homepage-gui
cp .env.example .env
```

The repository's `compose.yaml` pulls `hyprlab/homepage-gui:latest`. Point
`.env` at your host paths:

```ini
HOST_CONFIG_DIR=/path/to/homepage/config   # folder containing services.yaml
HOST_ICONS_DIR=/path/to/homepage/icons     # shared custom-icons folder
HOST_PORT=5005                             # browse to http://<host>:5005
```

Only `HOST_CONFIG_DIR` has to be right, and a parent of your config directory
works as well as the directory itself. If you don't know the path, start it
anyway: the wizard asks Docker and prints the exact path and compose line to
add. `HOMEPAGE_CONTAINER` is detected during setup.

To use custom icon uploads, mount the same icons folder into Homepage too
([Custom icon uploads](docs/DOCUMENTATION.md#custom-icon-uploads)).

```bash
docker compose up -d
```

Open `http://<host>:5005`. The first visit runs a setup wizard:

1. **Welcome:** a reminder that this edits an existing Homepage install.
2. **Create the admin account:** username and password (8 characters or more).
   This is the only account.
3. **Connect to Homepage:** the files it found, each with why it turned up, its
   path on the host, and whether it's writable. The likeliest one is selected.
4. **You're all set:** confirms the file it will write to, so a bad mount shows
   up here rather than on your first save.

## Updating

```bash
docker compose pull && docker compose up -d
```

To pin a version, set `IMAGE=hyprlab/homepage-gui:1.2.0` in `.env`. Existing
installs keep their settings; the wizard only runs when there's no account yet.

## Documentation

- [Documentation](docs/DOCUMENTATION.md): finding `services.yaml`,
  configuration, the sign-in, backups, icons, and running from source.
- [Changelog](CHANGELOG.md), also shown in the app: click the version in the
  sidebar footer.
- [Contributing](docs/CONTRIBUTING.md) and [releasing](docs/RELEASING.md).

## AI notice

Homepage GUI is built by a human maintainer working with generative AI as a
development tool:

- **Code:** the large majority of the Python and JavaScript in this repository
  was written with Anthropic's Claude (via Claude Code), working from the
  maintainer's direction. The maintainer decides what gets built, reviews the
  results, tests every release, and signs off on everything that ships.
- **Text:** documentation, release notes, and in-app copy are largely
  AI-drafted and human-edited.
- **The app itself contains no AI.** Homepage GUI has no AI features and makes
  no requests to AI services; it only reads and writes the `services.yaml` on
  your own server. AI was used to build the app, not to run it.

Bug reports and pull requests are welcome from humans and their AI tools
alike; everything merged gets the same human review.

## License

Licensed under the **GNU Affero General Public License v3.0**; see
[LICENSE](LICENSE). Because Homepage GUI is network-served software, AGPL §13
requires that people who use a modified version over a network can get its
source. The in-app **Source** link and `SOURCE_URL` exist for this: point them
at your fork if you modify it.
