# Documentation

Configuring and running Homepage GUI. Installing is in the
[README](../README.md#install-with-docker-compose).

## Finding your `services.yaml`

The wizard's **Connect to Homepage** step answers "which file am I editing?"
for you, so a new install doesn't hinge on getting a path right in `.env`
first. It looks in two places:

1. **Every folder mounted into the container.** Each one is walked for a
   `services.yaml`, and a match is ranked higher when Homepage's other config
   files (`settings.yaml`, `widgets.yaml`, `bookmarks.yaml`, ...) sit beside
   it. Mount your config directory anywhere you like; the scan finds it.
2. **Docker, if its socket is mounted.** The Engine API says which container
   is Homepage and which *host* directory it has bound to `/app/config`.
   Cross-referenced with the host directories bound into this container, that
   pins down the file exactly, and names your Homepage container for the
   **Restart Homepage** button at the same time.

Each candidate is listed with why it turned up, its path on the host, and
whether this container can write to it. Pick one, or type a path yourself. If
Homepage's config directory isn't shared with this container yet, the wizard
says so and prints the compose line to add:

```
Homepage's config lives at /srv/homepage/config on the host, but that folder
isn't mounted into this container yet.

  volumes:
    - /srv/homepage/config:/config
```

Put that path in `HOST_CONFIG_DIR`, run `docker compose up -d` again, and
press **Scan again** in the wizard.

Your choice is saved in `DATA_DIR/settings.json` and takes precedence over
`SERVICES_PATH` and `HOMEPAGE_CONFIG_DIR`, so it survives container recreates
without an `.env` edit. To change it later, or if the file moves, click the
path under the **Homepage GUI** title in the header to reopen the same picker.

The scan only sees what's mounted into the container; it can't read the rest
of your host. That's the point of the Docker lookup: it can name a path the
container can't open, so you know what to mount.

## Configuration

These are set in `compose.yaml`'s `environment:` (container side) and `.env`
(host side). Verify the resolved config with `docker compose config`.

**Container environment variables**

| Variable | Default | What it does |
| --- | --- | --- |
| `HOMEPAGE_CONFIG_DIR` | `/config` | Directory (inside the container) holding `services.yaml` |
| `SERVICES_PATH` | `$HOMEPAGE_CONFIG_DIR/services.yaml` | Starting point for the file path; a file chosen in the app wins over it |
| `BACKUP_DIR` | beside `services.yaml` | Where backups are written; set it to pin them to one folder |
| `KEEP_BACKUPS` | `40` | Hard cap on the number of backups (`0` is unlimited) |
| `KEEP_BACKUP_DAYS` | `14` | Purge backups older than this many days (`0` keeps them forever) |
| `ICONS_DIR` | `/icons` | Where uploaded icons are stored (shared with Homepage) |
| `HOMEPAGE_CONTAINER` | `homepage` | Container restarted to load new icons (detected during setup) |
| `DOCKER_SOCK` | `/var/run/docker.sock` | Docker socket used for detection and the restart |
| `SOURCE_URL` | this repository | Source link shown in the app; set it to your fork if you modify it |
| `PORT` | `5000` | Port inside the container (the host port is mapped in compose) |
| `DATA_DIR` | `$HOMEPAGE_CONFIG_DIR/.homepage-gui` | Holds the account database, session key and `settings.json` |
| `SECRET_KEY` | generated in `DATA_DIR` | Session signing key |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | empty (off) | Cloudflare Turnstile on the sign-in; see [Turnstile](#cloudflare-turnstile) |
| `DATABASE_URL` | `sqlite:///$DATA_DIR/homepage-gui.db` | Account database location |
| `ICON_CACHE_DIR` | `$DATA_DIR/icon-cache` | Disk cache for Iconify icons, search results and the dashboard-icons index |
| `ICON_CACHE_MAX` | `20000` | Cached icon bodies kept before the oldest are pruned (about 400 bytes each) |

**`.env` (host side, used by compose)**

| Variable | Example | What it does |
| --- | --- | --- |
| `HOST_CONFIG_DIR` | `/srv/homepage/config` | Host path mounted to `/config`; the wizard can tell you this one |
| `HOST_ICONS_DIR` | `/srv/homepage/icons` | Host path mounted to `/icons` |
| `HOST_PORT` | `5005` | Host port mapped to the container's `5000` |
| `HOMEPAGE_CONTAINER` | `homepage` | Passed through for the restart |
| `IMAGE` | `hyprlab/homepage-gui:1.2.0` | Pin an image tag |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | `0x4AAA...` | Cloudflare Turnstile on the sign-in |
| `SECRET_KEY` | `a1b2c3...` | Pin the session signing key |

The container runs as `root` (`user: "0:0"`) so it can write a typically
root-owned `services.yaml`. Change `user:` if your config files are owned by a
different UID and GID.

## The sign-in

Homepage GUI edits the file your dashboard runs on, so it has a sign-in. There
is one account, created by the setup wizard, and no registration page. Every
page and every `/api/*` route needs a session. Sign out from the button in the
top bar.

The account database and the session signing key sit in `DATA_DIR`, which
defaults to `.homepage-gui/` inside the config directory you already mount, so
they survive container recreates with no extra volume. To keep them out of
your Homepage config, point `DATA_DIR` at a named volume:

```yaml
    environment:
      - DATA_DIR=/data
    volumes:
      - homepage-gui-data:/data
```

### Cloudflare Turnstile

If the GUI is reachable from the internet, you can put a Turnstile challenge on
the sign-in. Create a widget under Cloudflare dashboard > Turnstile, then put
the pair in `.env`:

```env
TURNSTILE_SITE_KEY=0x4AAAAAAA...
TURNSTILE_SECRET_KEY=0x4AAAAAAA...
```

The challenge is verified against Cloudflare before the password is checked.
Leave either value empty and the challenge is skipped. If Cloudflare can't be
reached, the sign-in fails rather than letting people through.

### Forgot the password

There's no reset link. Delete the account database and the next start runs the
setup wizard again:

```bash
docker compose down
sudo rm /path/to/homepage/config/.homepage-gui/homepage-gui.db
docker compose up -d
```

Your `services.yaml`, backups and uploaded icons are untouched.

### The session

- The session cookie is `HttpOnly` and `SameSite=Lax`, signed with
  `SECRET_KEY`, so sign-ins survive restarts.
- **Keep me signed in** issues a long-lived remember cookie; without it the
  session ends with the browser.
- Writes (`POST`, `PUT`, `PATCH`, `DELETE`) carry a per-session CSRF token: a
  hidden `_csrf` field in forms, or an `X-CSRF` header from the editor's API
  calls. To script against the API, read the token from the
  `<meta name="csrf">` tag on any page and send it in that header with the same
  cookie jar.
- `/api/health` answers without a session for container health checks, and
  reports nothing beyond `{"ok": true}` until you sign in.
- Beyond your LAN, put the GUI behind HTTPS: over plain HTTP the session cookie
  travels in the clear.

## Using the app

- **Add a section:** the `+` in the sidebar, or drag the Section block onto
  the canvas.
- **Add a service:** a section's `+`, or drag the Service block into a
  section.
- **Edit:** click ✎ on a card, or double-click it. Use **Advanced (YAML)** for
  widgets and other keys.
- **Reorder or move:** drag the ⠿ handles, including across sections.
- **Sort a section:** the ⇅ button toggles A to Z and Z to A.
- **Preview:** the exact YAML before saving.
- **Save:** `Ctrl/Cmd+S` or the Save button. A backup is taken first.
- **Backups:** restore a previous version from the Backups dialog.
- **Change the file:** click the path under the title in the header.
- **About:** click the version in the sidebar footer for the project links and
  the release notes.

## Custom icon uploads

Homepage serves local icons from `/app/public/icons`, referenced as
`/icons/<file>`. For uploads to appear in Homepage, the same host folder must
be mounted into both containers. Add this volume to your Homepage
`compose.yaml` and recreate Homepage once:

```yaml
services:
  homepage:
    volumes:
      - /path/to/homepage/config:/app/config
      - /path/to/homepage/icons:/app/public/icons   # matches HOST_ICONS_DIR
```

The **My Uploads** tab in the icon chooser takes PNG and SVG files. Homepage
only reads `public/icons` at startup, so a new upload needs a Homepage restart:
upload, select the icon for a service, **Save**, then **Restart Homepage** in
the sidebar.

The Docker socket mount does two jobs: it lets **Restart Homepage** work, and
it lets the setup wizard identify your Homepage container and its config
directory. Without it everything else still works, but you restart Homepage
yourself and the wizard can only search the folders you've mounted.

## Backups

Every save and restore first writes a timestamped copy to a
`.homepage-gui-backups/` folder beside your `services.yaml` (Homepage ignores
dot-folders). Set `BACKUP_DIR` to pin them to one place; otherwise they follow
the file if you change it. Backups older than `KEEP_BACKUP_DAYS` are purged,
with `KEEP_BACKUPS` as a hard cap. Purging runs on each save and whenever the
page or the Backups dialog loads.

## How icons render

Icon previews and search use the Iconify API and jsDelivr, the same CDNs
Homepage uses, so the browser you edit from needs internet access for them.
Editing and saving work offline.

## Limitations

- Comments in `services.yaml`, other than the standard header, are not kept:
  the file is regenerated from the parsed structure. The previous version is
  always backed up first.
- Group-level settings (a section whose value is a mapping rather than a list
  of services) are shown read-only and kept verbatim.

## Running from source

Build and run the image locally with `docker compose up -d --build`, or
`tools/redeploy.sh`, which also waits for the app to answer.

To run Flask directly:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
HOMEPAGE_CONFIG_DIR=/path/to/homepage/config \
ICONS_DIR=/path/to/homepage/icons \
DATA_DIR=./devdata \
.venv/bin/python app.py            # http://localhost:5000
```

The first run opens the setup wizard. `DATA_DIR` keeps the development account
out of your real config directory; delete it to start over.

**Stack:** Flask, Flask-Login, SQLAlchemy, PyYAML and gunicorn on the server;
plain JavaScript with SortableJS and js-yaml in the browser; bundled
[Inter](https://rsms.me/inter/). There is no build step, and the only database
is a single-table SQLite file holding the admin account.
