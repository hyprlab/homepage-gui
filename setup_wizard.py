"""First-run setup wizard.

Shown exactly once: while the instance has zero users, every request is
steered to /setup. The wizard creates the admin account in one POST and signs
it in, after which the app behaves normally.

(Named setup_wizard.py rather than setup.py so it can't be mistaken for a
packaging script at the repo root.)
"""

from flask import (
    Blueprint,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    url_for,
)
from flask_login import login_user

from models import User, db

bp = Blueprint("setup", __name__)

# Once we've seen a user, skip the DB check on every request (per process).
_completed = {"done": False}

MIN_PASSWORD = 8
MAX_USERNAME = 80


def needs_setup() -> bool:
    if _completed["done"]:
        return False
    if db.session.query(User.id).first() is not None:
        _completed["done"] = True
        return False
    return True


@bp.route("/setup")
def wizard():
    if not needs_setup():
        return redirect(url_for("auth.login"))
    return render_template("setup.html", services_path=current_app.config["SERVICES_PATH"])


@bp.route("/setup", methods=["POST"])
def submit():
    if not needs_setup():
        return jsonify(error="This instance is already set up."), 409
    data = request.get_json(silent=True) or {}

    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username or len(username) > MAX_USERNAME or " " in username:
        return jsonify(error="Pick a username with no spaces."), 400
    if len(password) < MIN_PASSWORD:
        return jsonify(error="Passwords need at least %d characters." % MIN_PASSWORD), 400
    if password != (data.get("confirm") or ""):
        return jsonify(error="Passwords don't match."), 400

    admin = User(
        username=username,
        is_admin=True,
        name=(data.get("name") or "").strip()[:120] or None,
    )
    admin.set_password(password)
    db.session.add(admin)
    db.session.commit()

    _completed["done"] = True
    login_user(admin, remember=True)
    return jsonify(ok=True)
