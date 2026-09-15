"""Homepage GUI — a drag-and-drop editor for Homepage's services.yaml."""

import os
import secrets
import time
from datetime import datetime, timezone

from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    send_from_directory,
    session,
    url_for,
)
from flask_login import LoginManager, current_user
from werkzeug.utils import secure_filename

import app_settings
import auth
import discovery
import setup_wizard
from icon_cache import IconCache, RateLimited
from models import User, db
from yaml_store import HEADER, ServicesStore, COMMON_FIELDS

CONFIG_DIR = os.environ.get("HOMEPAGE_CONFIG_DIR", "/config")
# Where services.yaml lives when nothing has been detected or chosen yet. The
# setup wizard finds the real file (see discovery.py) and records it, so a new
# install never has to get this right in compose first — see services_path().
DEFAULT_SERVICES_PATH = os.environ.get(
    "SERVICES_PATH", os.path.join(CONFIG_DIR, "services.yaml")
)
# An explicit BACKUP_DIR pins backups; otherwise they sit in a dot-folder next
# to services.yaml, so they follow the file if the configured path changes.
BACKUP_DIR = os.environ.get("BACKUP_DIR")
KEEP_BACKUPS = int(os.environ.get("KEEP_BACKUPS", "40"))
KEEP_BACKUP_DAYS = int(os.environ.get("KEEP_BACKUP_DAYS", "14"))

APP_VERSION = "0.3.0"
# Public source location (AGPL §13). Override if you run a modified version so
# your network users can reach *your* corresponding source.
SOURCE_URL = os.environ.get("SOURCE_URL", "https://github.com/hyprlab/homepage-gui")
# Shown in the About dialog. The upstream project this edits, this project's
# own page, and who to credit.
UPSTREAM_URL = os.environ.get("UPSTREAM_URL", "https://gethomepage.dev")
PROJECT_URL = os.environ.get("PROJECT_URL", "https://hyprlab.co/homepage-gui/")
VENDOR_URL = os.environ.get("VENDOR_URL", "https://hyprlab.co")
VENDOR_NAME = os.environ.get("VENDOR_NAME", "Hyprlab")
# Single source of truth for release notes, shown in-app and on GitHub.
CHANGELOG_PATH = os.environ.get(
    "CHANGELOG_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "CHANGELOG.md")
)

# Custom icons: written here, mounted into Homepage at /app/public/icons and
# referenced in services.yaml as /icons/<file>.
ICONS_DIR = os.environ.get("ICONS_DIR", "/icons")
ALLOWED_ICON_EXT = {".png", ".svg"}
# Container to restart so Homepage picks up newly-uploaded icons.
HOMEPAGE_CONTAINER = os.environ.get("HOMEPAGE_CONTAINER", "homepage")
DOCKER_SOCK = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")

os.makedirs(ICONS_DIR, exist_ok=True)

# The account database and session key live here — a dot-folder inside the
# mounted config dir, so they persist with no extra volume. Point DATA_DIR at a
# dedicated volume if you'd rather keep them out of the Homepage config.
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(CONFIG_DIR, ".homepage-gui"))
os.makedirs(DATA_DIR, exist_ok=True)

# Choices made in the app (which services.yaml, which Homepage container) live
# beside the account database rather than in the environment.
settings = app_settings.Settings(DATA_DIR)


def services_path():
    """The services.yaml this app reads and writes.

    A path chosen in the app beats the environment default: the point of the
    setup wizard is that a fresh install can locate the real file and start
    editing, with no edit-compose-and-recreate round trip.
    """
    return settings.get("services_path") or DEFAULT_SERVICES_PATH


def backup_dir_for(path):
    return BACKUP_DIR or os.path.join(
        os.path.dirname(path) or CONFIG_DIR, ".homepage-gui-backups"
    )


_store_cache = {}


def get_store():
    """A ServicesStore bound to whichever path is configured right now."""
    path = services_path()
    store = _store_cache.get("store")
    if store is None or store.path != path:
        store = ServicesStore(
            path, backup_dir_for(path), keep=KEEP_BACKUPS, keep_days=KEEP_BACKUP_DAYS
        )
        _store_cache["store"] = store
    return store


def homepage_container():
    return settings.get("homepage_container") or HOMEPAGE_CONTAINER


# Iconify previews are proxied through this app and cached on disk. Pointing the
# browser straight at api.iconify.design meant one request per icon — a single
# picker search fired ~130 and tripped Cloudflare's rate limit for the whole
# source IP, after which every preview fell back to "?".
ICON_CACHE_DIR = os.environ.get("ICON_CACHE_DIR") or os.path.join(DATA_DIR, "icon-cache")
ICON_CACHE_MAX = int(os.environ.get("ICON_CACHE_MAX") or "20000")


def _secret_key():
    """Use SECRET_KEY from the environment, otherwise persist one in the data
    dir so sessions survive restarts."""
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    keyfile = os.path.join(DATA_DIR, ".secret_key")
    try:
        with open(keyfile, "r", encoding="utf-8") as fh:
            key = fh.read().strip()
        if key:
            return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(key)
    return key


app = Flask(__name__)
# Preserve our model's key order through the JSON API instead of alphabetizing.
app.json.sort_keys = False
# Cap upload size (icons are small).
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
app.config.update(
    SECRET_KEY=_secret_key(),
    SQLALCHEMY_DATABASE_URI=os.environ.get(
        "DATABASE_URL", "sqlite:///%s" % os.path.join(DATA_DIR, "homepage-gui.db")
    ),
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True},
    # Cloudflare Turnstile — leave unset to disable the challenge (e.g. LAN use).
    TURNSTILE_SITE_KEY=os.environ.get("TURNSTILE_SITE_KEY", ""),
    TURNSTILE_SECRET_KEY=os.environ.get("TURNSTILE_SECRET_KEY", ""),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    REMEMBER_COOKIE_HTTPONLY=True,
    REMEMBER_COOKIE_SAMESITE="Lax",
)

db.init_app(app)

login_manager = LoginManager(app)
login_manager.login_view = "auth.login"


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


@login_manager.unauthorized_handler
def unauthorized():
    """API callers get JSON they can act on; browsers get the login page."""
    if request.path.startswith("/api/"):
        return jsonify({"error": "Authentication required", "login": url_for("auth.login")}), 401
    return redirect(url_for("auth.login", next=request.path))


app.register_blueprint(auth.bp)
app.register_blueprint(setup_wizard.bp)
# The wizard runs detection before any account exists, so it reaches the
# implementation through the app rather than importing it (app imports it).
app.config["DETECT_CONNECTION"] = lambda refresh=False: run_detect(refresh)

icons_cache = IconCache(ICON_CACHE_DIR, max_icons=ICON_CACHE_MAX)

docker = discovery.Docker(DOCKER_SOCK)


def restart_homepage():
    """Restart the Homepage container via the Docker Engine API."""
    docker.restart(homepage_container())


@app.context_processor
def inject_static_version():
    """Append a ?v=<mtime> query to static URLs so browsers re-fetch on change."""

    def static_url(filename):
        full = os.path.join(app.static_folder, filename)
        try:
            ver = int(os.path.getmtime(full))
        except OSError:
            ver = 0
        return url_for("static", filename=filename, v=ver)

    return {"static_url": static_url}


# ---------------------------------------------------------------------------
# Setup steering, auth guard and CSRF
# ---------------------------------------------------------------------------
# Reachable without a session; everything else needs one.
PUBLIC_ENDPOINTS = {
    "auth.login", "auth.logout", "setup.wizard", "setup.submit", "setup.detect",
    "static", "health",
}


@app.before_request
def steer_to_setup():
    """A fresh install (zero users) goes to the wizard, nowhere else."""
    if request.endpoint in ("setup.wizard", "setup.submit", "setup.detect", "static"):
        return None
    if setup_wizard.needs_setup():
        if request.path.startswith("/api/"):
            return jsonify({"error": "This instance isn't set up yet.", "setup": url_for("setup.wizard")}), 401
        return redirect(url_for("setup.wizard"))
    return None


@app.before_request
def require_login():
    """Guard every route in one place, so a new endpoint is protected by
    default rather than by remembering a decorator."""
    if request.endpoint in PUBLIC_ENDPOINTS or current_user.is_authenticated:
        return None
    return app.login_manager.unauthorized()


# ---- CSRF (lightweight, session-token based) ----
def csrf_token() -> str:
    if "_csrf" not in session:
        session["_csrf"] = secrets.token_hex(16)
    return session["_csrf"]


@app.before_request
def check_csrf():
    if request.method not in ("POST", "PUT", "PATCH", "DELETE"):
        return None
    sent = request.headers.get("X-CSRF") or request.form.get("_csrf")
    if not sent or sent != session.get("_csrf"):
        return {"error": "Invalid or missing CSRF token."}, 400
    return None


@app.after_request
def no_stale_html(resp):
    # Never let a signed-in page be replayed from cache after sign-out.
    if resp.mimetype == "text/html":
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.context_processor
def inject_globals():
    return {
        "csrf_token": csrf_token,
        "turnstile_site_key": app.config["TURNSTILE_SITE_KEY"],
        "app_version": APP_VERSION,
        "source_url": SOURCE_URL,
        "upstream_url": UPSTREAM_URL,
        "project_url": PROJECT_URL,
        "vendor_url": VENDOR_URL,
        "vendor_name": VENDOR_NAME,
        # Evaluated per render, so a container that runs into January doesn't
        # keep claiming last year.
        "current_year": datetime.now(timezone.utc).year,
    }


@app.route("/")
def index():
    return render_template(
        "index.html",
        common_fields=COMMON_FIELDS,
        services_path=services_path(),
    )


@app.route("/api/changelog")
def changelog():
    try:
        with open(CHANGELOG_PATH, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        text = "# Changelog\n\nRelease notes are unavailable."
    return jsonify({"version": APP_VERSION, "source_url": SOURCE_URL, "markdown": text})


@app.route("/api/health")
def health():
    # Stays reachable without a session so container health checks keep
    # working, but it gives nothing away about the host's filesystem.
    if not current_user.is_authenticated:
        return jsonify({"ok": True, "auth_required": True})
    return jsonify(dict(connection_state(), ok=True))


@app.route("/api/config", methods=["GET"])
def get_config():
    try:
        return jsonify(get_store().load())
    except FileNotFoundError:
        # The UI turns this into "let's find your services.yaml" rather than a
        # dead end, so say plainly that the path is the problem.
        return jsonify(
            {
                "error": "No services.yaml at %s" % services_path(),
                "missing_file": True,
                "services_path": services_path(),
            }
        ), 404
    except Exception as exc:  # noqa: BLE001 - surface parse errors to the UI
        return jsonify({"error": str(exc)}), 500


@app.route("/api/config", methods=["POST"])
def save_config():
    payload = request.get_json(silent=True)
    if not payload or "groups" not in payload:
        return jsonify({"error": "Expected JSON with a 'groups' array"}), 400
    try:
        backup = get_store().save(payload)
        return jsonify({"ok": True, "backup": backup})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 500


@app.route("/api/preview", methods=["POST"])
def preview():
    """Render the model to YAML text without saving (for the preview pane)."""
    from yaml_store import serialize

    payload = request.get_json(silent=True) or {}
    try:
        return jsonify({"yaml": serialize(payload)})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400


@app.route("/api/backups", methods=["GET"])
def list_backups():
    store = get_store()
    store.prune()  # purge expired backups when the list is opened
    return jsonify({"backups": store.list_backups(), "keep_days": KEEP_BACKUP_DAYS})


@app.route("/api/backups/<name>", methods=["GET"])
def get_backup(name):
    try:
        return jsonify({"name": name, "yaml": get_store().backup_text(name)})
    except FileNotFoundError:
        return jsonify({"error": "Backup not found"}), 404


@app.route("/api/backups/restore", methods=["POST"])
def restore_backup():
    payload = request.get_json(silent=True) or {}
    name = payload.get("name")
    if not name:
        return jsonify({"error": "Expected 'name'"}), 400
    try:
        get_store().restore(name)
        return jsonify({"ok": True})
    except FileNotFoundError:
        return jsonify({"error": "Backup not found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


# ---------------------------------------------------------------------------
# Homepage connection — where services.yaml is, and which container to restart
# ---------------------------------------------------------------------------
# Detection walks every mounted filesystem, so a result is worth reusing for a
# little while (the wizard asks for it, then the user re-reads it as they pick).
_detect_cache = {"at": 0.0, "data": None}
DETECT_TTL = 45.0
# Same idea for the Docker lookup behind "what host path is this, really?".
_mounts_cache = {"at": None, "mounts": []}
MOUNTS_TTL = 60.0


def self_mounts():
    """Host dir -> container dir for this container, as Docker sees it."""
    now = time.monotonic()
    if _mounts_cache["at"] is None or now - _mounts_cache["at"] > MOUNTS_TTL:
        _mounts_cache["mounts"] = discovery.docker_survey(docker)["self_mounts"]
        _mounts_cache["at"] = now
    return _mounts_cache["mounts"]


def connection_state():
    """Everything the UI needs to describe the current wiring."""
    path = services_path()
    exists = os.path.isfile(path)
    parent = os.path.dirname(path) or "/"
    return {
        "services_path": path,
        "host_path": discovery.local_to_host(path, self_mounts()),
        "exists": exists,
        "writable": os.access(path, os.W_OK) if exists else os.access(parent, os.W_OK),
        "dir_mounted": os.path.isdir(parent),
        "backup_dir": backup_dir_for(path),
        "homepage_container": homepage_container(),
        "docker_available": docker.available,
        # True once someone has picked a path in the app, as opposed to falling
        # back to HOMEPAGE_CONFIG_DIR/SERVICES_PATH from the environment.
        "chosen_in_app": bool(settings.get("services_path")),
        "default_path": DEFAULT_SERVICES_PATH,
    }


class PathProblem(ValueError):
    """A rejected path, with a message meant to be read by whoever typed it.

    `can_create` marks the one case the UI can resolve by itself: the folder is
    there, the file simply isn't, so it can offer to make an empty one.
    """

    def __init__(self, message, can_create=False):
        super().__init__(message)
        self.can_create = can_create


def _resolve_target(raw, create):
    """Validate a user-supplied path, optionally creating an empty file."""
    if not raw.startswith("/"):
        raise PathProblem(
            "Use an absolute path as this container sees it, e.g. /config/services.yaml."
        )
    path = os.path.normpath(raw)
    if os.path.isdir(path):
        path = os.path.join(path, "services.yaml")
    if os.path.splitext(path)[1].lower() not in (".yaml", ".yml"):
        raise PathProblem("Pick a .yaml file — Homepage's is called services.yaml.")

    if os.path.exists(path):
        if not os.path.isfile(path):
            raise PathProblem("%s isn't a file." % path)
        if not os.access(path, os.R_OK):
            raise PathProblem("Can't read %s — check the file's permissions." % path)
        return path

    parent = os.path.dirname(path) or "/"
    if not os.path.isdir(parent):
        raise PathProblem(
            "This container can't see %s. Mount your Homepage config directory "
            "into it and try again." % parent
        )
    if not create:
        raise PathProblem("There's no file at %s yet." % path, can_create=True)
    if not os.access(parent, os.W_OK):
        raise PathProblem(
            "%s is read-only for this container, so nothing can be created there." % parent
        )
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(HEADER)
    return path


@app.route("/api/connection", methods=["GET"])
def get_connection():
    return jsonify(connection_state())


def run_detect(refresh=False):
    """Detection plus the current wiring, memoised for DETECT_TTL seconds.

    The setup wizard calls this through its own route (before an account
    exists) and the app calls it through /api/connection/detect afterwards;
    sharing the cache means the wizard can start the scan while the user is
    still typing a password, and the result is waiting when they get there.
    """
    now = time.monotonic()
    if refresh or not _detect_cache["data"] or now - _detect_cache["at"] > DETECT_TTL:
        _detect_cache["data"] = discovery.detect(
            current_path=services_path(),
            default_path=DEFAULT_SERVICES_PATH,
            exclude_dirs=[DATA_DIR, ICONS_DIR, ICON_CACHE_DIR],
            docker=docker,
        )
        _detect_cache["at"] = now
    return dict(_detect_cache["data"], current=connection_state())


@app.route("/api/connection/detect", methods=["GET"])
def detect_connection():
    """Hunt for services.yaml across every mount and ask Docker about Homepage."""
    return jsonify(run_detect(request.args.get("refresh") == "1"))


@app.route("/api/connection", methods=["POST"])
def set_connection():
    """Point the editor at a services.yaml (and optionally name the container)."""
    payload = request.get_json(silent=True) or {}
    raw = (payload.get("path") or "").strip()
    container = payload.get("homepage_container")
    updates = {}

    if raw:
        try:
            updates["services_path"] = _resolve_target(raw, bool(payload.get("create")))
        except PathProblem as exc:
            return jsonify({"error": str(exc), "can_create": exc.can_create}), 400
        except OSError as exc:
            return jsonify({"error": "Couldn't create that file: %s" % exc}), 400

    if container is not None:
        # Empty clears the override and falls back to HOMEPAGE_CONTAINER.
        updates["homepage_container"] = str(container).strip()[:128] or None

    if updates:
        try:
            settings.set(**updates)
        except OSError as exc:
            return jsonify({"error": "Couldn't save the setting: %s" % exc}), 500
        _detect_cache["data"] = None

    return jsonify(dict(connection_state(), ok=True))


# ---------------------------------------------------------------------------
# Iconify / dashboard-icons proxy (disk-cached)
# ---------------------------------------------------------------------------
@app.route("/api/iconify/icons", methods=["GET"])
def iconify_icons():
    """Resolve a batch of `prefix:name` refs to inline-SVG bodies."""
    raw = request.args.get("icons", "")
    refs = [r.strip() for r in raw.split(",") if r.strip()][:200]
    if not refs:
        return jsonify({"icons": {}, "missing": []})
    found, missing, limited, retry = icons_cache.get_icons(refs)
    return jsonify(
        {"icons": found, "missing": missing, "rateLimited": limited, "retryAfter": retry}
    )


@app.route("/api/iconify/search", methods=["GET"])
def iconify_search():
    query = request.args.get("query", "").strip()
    if not query:
        return jsonify({"icons": []})
    prefix = request.args.get("prefix") or None
    try:
        limit = max(1, min(int(request.args.get("limit", "100")), 200))
    except ValueError:
        limit = 100
    try:
        data, stale = icons_cache.search(query, prefix, limit)
    except RateLimited as exc:
        return jsonify({"error": "Iconify is rate limiting this host.",
                        "rateLimited": True, "retryAfter": exc.retry_after}), 503
    except Exception as exc:  # noqa: BLE001 - surface upstream trouble to the UI
        return jsonify({"error": str(exc)}), 502
    data = dict(data or {})
    data["stale"] = stale
    return jsonify(data)


@app.route("/api/dashboard/tree", methods=["GET"])
def dashboard_tree():
    try:
        data, stale = icons_cache.dashboard_tree()
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502
    return jsonify({"svg": (data or {}).get("svg", []), "stale": stale})


@app.route("/api/iconify/stats", methods=["GET"])
def iconify_stats():
    return jsonify(icons_cache.stats())


# ---------------------------------------------------------------------------
# Custom icon uploads
# ---------------------------------------------------------------------------
def _list_icons():
    items = []
    for name in os.listdir(ICONS_DIR):
        ext = os.path.splitext(name)[1].lower()
        if ext not in ALLOWED_ICON_EXT:
            continue
        full = os.path.join(ICONS_DIR, name)
        if not os.path.isfile(full):
            continue
        st = os.stat(full)
        items.append(
            {"name": name, "ref": "/icons/%s" % name, "size": st.st_size, "mtime": st.st_mtime}
        )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items


def _unique_icon_name(name):
    base, ext = os.path.splitext(name)
    candidate = name
    i = 1
    while os.path.exists(os.path.join(ICONS_DIR, candidate)):
        candidate = "%s-%d%s" % (base, i, ext)
        i += 1
    return candidate


@app.route("/api/icons", methods=["GET"])
def list_icons():
    return jsonify({"icons": _list_icons(), "homepage_container": homepage_container()})


@app.route("/api/icons", methods=["POST"])
def upload_icon():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "No file provided"}), 400

    cleaned = secure_filename(f.filename)
    base, ext = os.path.splitext(cleaned)
    ext = ext.lower()
    if ext not in ALLOWED_ICON_EXT:
        return jsonify({"error": "Only .png and .svg files are allowed"}), 400
    if not base:
        base = "icon"
        cleaned = base + ext

    name = _unique_icon_name(cleaned)
    f.save(os.path.join(ICONS_DIR, name))
    return jsonify({"ok": True, "name": name, "ref": "/icons/%s" % name})


@app.route("/api/icons/<name>", methods=["DELETE"])
def delete_icon(name):
    safe = secure_filename(name)
    full = os.path.join(ICONS_DIR, safe)
    if not os.path.isfile(full):
        return jsonify({"error": "Icon not found"}), 404
    os.remove(full)
    return jsonify({"ok": True})


@app.route("/icons/<path:name>", methods=["GET"])
def serve_icon(name):
    # Serve uploaded icons so the GUI can preview them at the same /icons/<file>
    # path Homepage uses.
    safe = secure_filename(os.path.basename(name))
    if not safe or not os.path.isfile(os.path.join(ICONS_DIR, safe)):
        abort(404)
    return send_from_directory(ICONS_DIR, safe)


@app.route("/api/homepage/restart", methods=["POST"])
def homepage_restart():
    try:
        restart_homepage()
        return jsonify({"ok": True})
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@app.route("/api/download", methods=["GET"])
def download():
    return send_file(
        services_path(),
        mimetype="text/yaml",
        as_attachment=True,
        download_name="services.yaml",
    )


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=True)
