"""Sign-in for Homepage GUI.

One admin account, created by the first-run setup wizard (see setup_wizard.py).
There is no registration route — this is a single-operator tool.

Cloudflare Turnstile guards the login POST when TURNSTILE_SITE_KEY and
TURNSTILE_SECRET_KEY are set; with no secret configured the check is skipped,
so local and LAN installs need no Cloudflare account.
"""

import requests
from flask import Blueprint, current_app, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required, login_user, logout_user
from sqlalchemy import func

from models import User

bp = Blueprint("auth", __name__)

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def verify_turnstile() -> bool:
    """Validate the Turnstile token if Turnstile is configured; pass otherwise."""
    secret = current_app.config["TURNSTILE_SECRET_KEY"]
    if not secret:
        return True
    token = request.form.get("cf-turnstile-response", "")
    if not token:
        return False
    try:
        resp = requests.post(
            TURNSTILE_VERIFY_URL,
            data={
                "secret": secret,
                "response": token,
                "remoteip": request.headers.get("CF-Connecting-IP", request.remote_addr),
            },
            timeout=10,
        )
        return bool(resp.json().get("success"))
    except requests.RequestException:
        return False


@bp.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("index"))
    if request.method == "POST":
        if not verify_turnstile():
            flash("Verification failed. Please try again.", "error")
            return render_template("login.html"), 400
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = User.query.filter(func.lower(User.username) == username.lower()).first()
        if user and user.check_password(password):
            login_user(user, remember=request.form.get("remember") == "on")
            dest = request.args.get("next")
            if dest and dest.startswith("/") and not dest.startswith("//"):
                return redirect(dest)
            return redirect(url_for("index"))
        flash("Wrong username or password.", "error")
        return render_template("login.html"), 401
    return render_template("login.html")


@bp.route("/logout", methods=["POST"])
@login_required
def logout():
    logout_user()
    return redirect(url_for("auth.login"))
