"""Homepage GUI — a drag-and-drop editor for Homepage's services.yaml."""

import os
import secrets
import socket
import http.client

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

import auth
import setup_wizard
from models import User, db
from yaml_store import ServicesStore, COMMON_FIELDS

CONFIG_DIR = os.environ.get("HOMEPAGE_CONFIG_DIR", "/config")
SERVICES_PATH = os.environ.get(
    "SERVICES_PATH", os.path.join(CONFIG_DIR, "services.yaml")
)
BACKUP_DIR = os.environ.get(
    "BACKUP_DIR", os.path.join(CONFIG_DIR, ".homepage-gui-backups")
)
KEEP_BACKUPS = int(os.environ.get("KEEP_BACKUPS", "40"))
KEEP_BACKUP_DAYS = int(os.environ.get("KEEP_BACKUP_DAYS", "14"))

APP_VERSION = "0.2.0"
# Public source location (AGPL §13). Override if you run a modified version so
# your network users can reach *your* corresponding source.
SOURCE_URL = os.environ.get("SOURCE_URL", "https://github.com/hyprlab/homepage-gui")
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
    # Read by the setup wizard so it can report on the target file.
    SERVICES_PATH=SERVICES_PATH,
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

store = ServicesStore(
    SERVICES_PATH, BACKUP_DIR, keep=KEEP_BACKUPS, keep_days=KEEP_BACKUP_DAYS
)


class _UnixHTTPConnection(http.client.HTTPConnection):
    """Talk HTTP over the Docker unix socket using only the stdlib."""

    def __init__(self, sock_path):
        super().__init__("localhost")
        self._sock_path = sock_path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(30)
        s.connect(self._sock_path)
        self.sock = s


def restart_homepage():
    """Restart the Homepage container via the Docker Engine API."""
    if not os.path.exists(DOCKER_SOCK):
        raise RuntimeError(
            "Docker socket not available — mount %s into this container to enable "
            "one-click restarts." % DOCKER_SOCK
        )
    conn = _UnixHTTPConnection(DOCKER_SOCK)
    try:
        conn.request("POST", "/containers/%s/restart?t=5" % HOMEPAGE_CONTAINER)
        resp = conn.getresponse()
        body = resp.read()
        if resp.status == 404:
            raise RuntimeError("Container '%s' not found." % HOMEPAGE_CONTAINER)
        if resp.status not in (204,):
            raise RuntimeError(
                "Docker API returned %s: %s" % (resp.status, body.decode("utf-8", "replace"))
            )
    finally:
        conn.close()


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
PUBLIC_ENDPOINTS = {"auth.login", "auth.logout", "setup.wizard", "setup.submit", "static", "health"}


@app.before_request
def steer_to_setup():
    """A fresh install (zero users) goes to the wizard, nowhere else."""
    if request.endpoint in ("setup.wizard", "setup.submit", "static"):
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
    }


@app.route("/")
def index():
    return render_template(
        "index.html",
        common_fields=COMMON_FIELDS,
        services_path=SERVICES_PATH,
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
    return jsonify(
        {
            "ok": True,
            "services_path": SERVICES_PATH,
            "exists": os.path.exists(SERVICES_PATH),
            "writable": os.access(SERVICES_PATH, os.W_OK)
            if os.path.exists(SERVICES_PATH)
            else os.access(os.path.dirname(SERVICES_PATH), os.W_OK),
        }
    )


@app.route("/api/config", methods=["GET"])
def get_config():
    try:
        return jsonify(store.load())
    except FileNotFoundError:
        return jsonify({"error": "services.yaml not found at %s" % SERVICES_PATH}), 404
    except Exception as exc:  # noqa: BLE001 - surface parse errors to the UI
        return jsonify({"error": str(exc)}), 500


@app.route("/api/config", methods=["POST"])
def save_config():
    payload = request.get_json(silent=True)
    if not payload or "groups" not in payload:
        return jsonify({"error": "Expected JSON with a 'groups' array"}), 400
    try:
        backup = store.save(payload)
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
    store.prune()  # purge expired backups when the list is opened
    return jsonify({"backups": store.list_backups(), "keep_days": KEEP_BACKUP_DAYS})


@app.route("/api/backups/<name>", methods=["GET"])
def get_backup(name):
    try:
        return jsonify({"name": name, "yaml": store.backup_text(name)})
    except FileNotFoundError:
        return jsonify({"error": "Backup not found"}), 404


@app.route("/api/backups/restore", methods=["POST"])
def restore_backup():
    payload = request.get_json(silent=True) or {}
    name = payload.get("name")
    if not name:
        return jsonify({"error": "Expected 'name'"}), 400
    try:
        store.restore(name)
        return jsonify({"ok": True})
    except FileNotFoundError:
        return jsonify({"error": "Backup not found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


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
    return jsonify({"icons": _list_icons(), "homepage_container": HOMEPAGE_CONTAINER})


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
        SERVICES_PATH,
        mimetype="text/yaml",
        as_attachment=True,
        download_name="services.yaml",
    )


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=True)
