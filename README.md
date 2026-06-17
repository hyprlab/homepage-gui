# Homepage GUI

A Docker-based Flask web app for visually editing [Homepage](https://gethomepage.dev)'s
`services.yaml` — drag-and-drop to organize sections and services, edit fields, and
pick icons (MDI, Font Awesome, dashboard icons, and any SVG via freesvgicons/Iconify).

No login required. Designed for LAN use on your homelab.

![sections + drag and drop]

## Features

- **Drag & drop** sections (reorder) and services (reorder within a section and move
  between sections), powered by SortableJS.
- **Sidebar** with a section navigator and draggable "Service" / "Section" blocks you
  can drop onto the canvas (or click to append).
- **Inline editing** of each service: name, icon, URL (`href`), description, and `ping`,
  plus an **Advanced (YAML)** area for widgets, `server`/`container`, and any other keys —
  nothing in your file is lost.
- **Icon chooser** with four sources:
  - **Dashboard Icons** → `name.svg` (Homepage's native icon set)
  - **Material Design Icons** → `mdi-name`, with a color picker → `mdi-name-#hex`
  - **Font Awesome** (free) → `fas-`/`far-`/`fab-` prefixes
  - **SVG / freesvgicons** → searches 200k+ Iconify icons and stores the chosen icon as
    a direct SVG URL (works anywhere Homepage accepts a URL icon). A link to
    [freesvgicons.com](https://freesvgicons.com/) is included for browsing.
  - **My Uploads** → upload your own **PNG/SVG** icons (button or drag-and-drop). They're
    stored in a shared folder Homepage serves and referenced as `/icons/<file>`. A
    **Restart Homepage** button (via the Docker socket) makes new uploads take effect.

### Custom icon uploads

Homepage only serves local icons from `/app/public/icons` (referenced as `/icons/<file>`)
and **must be restarted to pick up newly-added files**. To support this, both containers
share a host folder:

- `compose.yaml` (this app) mounts your icons folder (`HOMEPAGE_ICONS_DIR`) at `/icons`
  plus the Docker socket (so the GUI can restart Homepage).
- Homepage's own compose mounts the **same** host folder at `/app/public/icons`.

Workflow: open the icon chooser → **My Uploads** → upload a PNG/SVG → select it for a
service → **Save** → click **Restart Homepage**. Set `HOMEPAGE_CONTAINER` if your Homepage
container isn't named `homepage`. If the Docker socket isn't mounted, uploads still work —
just restart Homepage yourself.
- **Safe saves**: every save first writes a timestamped backup; generated YAML is
  validated before it touches your file, and writes are atomic.
- **Backups & restore** from the UI, and a **YAML preview** before saving.
- Common fields are always emitted in Homepage's conventional order
  (`icon`, `href`, `description`, `ping`), and empty fields stay blank (not `null`).

## Run it

Using the published image with Docker Compose:

```bash
git clone https://github.com/viibeware/homepage-gui.git
cd homepage-gui
cp .env.example .env      # then edit the paths/port for your host
docker compose up -d      # add --build to build locally instead of pulling
```

Then open **http://&lt;host&gt;:5005** (the port set by `HOST_PORT`) from any device on the LAN.

`.env` points the container at your live Homepage config and icons folders:

```ini
HOMEPAGE_CONFIG_DIR=/path/to/homepage/config
HOMEPAGE_ICONS_DIR=/path/to/homepage/icons
HOST_PORT=5005
HOMEPAGE_CONTAINER=homepage
```

Edits land directly on `<HOMEPAGE_CONFIG_DIR>/services.yaml`. Homepage hot-reloads its
config, so service/section changes appear without restarting Homepage (only new **icon
uploads** require a restart — use the sidebar button).

### Quick run without compose

```bash
docker run -d --name homepage-gui -p 5005:5000 \
  -v /path/to/homepage/config:/config \
  -v /path/to/homepage/icons:/icons \
  -v /var/run/docker.sock:/var/run/docker.sock \
  viibeware/homepage-gui:latest
```

### Backups

Backups are written to `/config/.homepage-gui-backups/` (a dot-folder Homepage ignores).
A backup is created on every save and restore. Backups older than `KEEP_BACKUP_DAYS`
(default **14 days**) are auto-purged, with a hard cap of `KEEP_BACKUPS` (default 40) as a
safety net. Purging runs on each save and whenever the page or the **Backups** dialog
loads, so old backups age out even if you stop saving. Restore any backup from the
**Backups** dialog.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `HOMEPAGE_CONFIG_DIR` | `/config` | Directory holding `services.yaml` |
| `SERVICES_PATH` | `$HOMEPAGE_CONFIG_DIR/services.yaml` | Override the exact file path |
| `BACKUP_DIR` | `$HOMEPAGE_CONFIG_DIR/.homepage-gui-backups` | Where backups are stored |
| `KEEP_BACKUPS` | `40` | Hard cap on number of backups (`0` = unlimited) |
| `KEEP_BACKUP_DAYS` | `14` | Auto-purge backups older than this many days (`0` = keep forever) |
| `ICONS_DIR` | `/icons` | Where uploaded custom icons are stored (shared with Homepage) |
| `HOMEPAGE_CONTAINER` | `homepage` | Container the GUI restarts so new icons are served |
| `PORT` | `5000` | In-container port (host port is mapped in compose) |

The container runs as `root` (`user: "0:0"`) so it can write the root-owned
`services.yaml`. Adjust the `user:` in `compose.yaml` if your config files are owned
by a different UID/GID.

## How icons render

Icon previews and search use public CDNs (Iconify API and jsDelivr), so the browser you
edit from needs internet access — the same CDNs Homepage itself uses for dashboard icons.
Core editing/saving works fully offline; only icon search/preview needs the network.

## Notes / limitations

- Comments in `services.yaml` (other than the standard header) are not preserved — the
  file is regenerated from the parsed structure. The previous version is always backed up.
- Group-level settings (a section whose value is a mapping rather than a list of services)
  are shown read-only and preserved verbatim; edit those via **Preview**/raw if needed.

## Stack

Flask + PyYAML + gunicorn (backend), vanilla JS + SortableJS + js-yaml (frontend).
[Inter](https://rsms.me/inter/) is bundled locally (SIL OFL). No build step, no database.

## License

Licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).
Because Homepage GUI is a network-served application, the AGPL's section 13 requires that
users who interact with a modified version over a network be able to obtain its source.
