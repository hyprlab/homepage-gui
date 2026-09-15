"""Disk-cached proxy for the Iconify API and the dashboard-icons index.

The editor used to point `<img src>` straight at api.iconify.design, one request
per icon. A single picker search fired ~130 of them, which trips Cloudflare's
rate limit (error 1015) for the whole source IP; the 429s come back as
`text/plain`, Chrome's Opaque Response Blocking refuses to hand those to an
`<img>`, and every preview silently falls back to "?".

Everything now goes through here instead. Icons are fetched in one batched
upstream call per prefix, sanitized, and kept on disk, so a warm cache never
touches the network at all — and a cold one costs a couple of requests rather
than a hundred.
"""

import hashlib
import json
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from concurrent import futures

import requests

ICONIFY_API = "https://api.iconify.design"
DASHBOARD_TREE_URL = (
    "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/tree.json"
)

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
ET.register_namespace("", SVG_NS)
ET.register_namespace("xlink", XLINK_NS)

# Iconify prefixes and names are lowercase alphanumerics with separators. Anything
# else is refused outright rather than sanitized, so nothing user-supplied can
# walk out of the cache directory.
SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")

# Conservative allowlist for the SVG markup we inject into the page. Iconify's
# bodies are plain drawing primitives; anything scriptable is dropped.
ALLOWED_TAGS = {
    "a", "animate", "animateMotion", "animateTransform", "circle", "clipPath",
    "defs", "desc", "ellipse", "feBlend", "feColorMatrix", "feComposite",
    "feDropShadow", "feFlood", "feGaussianBlur", "feMerge", "feMergeNode",
    "feMorphology", "feOffset", "filter", "g", "line", "linearGradient", "marker",
    "mask", "mpath", "path", "pattern", "polygon", "polyline", "radialGradient",
    "rect", "set", "stop", "svg", "symbol", "text", "textPath", "title", "tspan",
    "use",
}

ALLOWED_ATTRS = {
    "accumulate", "additive", "attributeName", "begin", "calcMode", "class",
    "clip-path", "clip-rule", "clipPathUnits", "color", "cx", "cy", "d", "dur",
    "dx", "dy", "fill", "fill-opacity", "fill-rule", "filter", "filterUnits",
    "flood-color", "flood-opacity", "font-family", "font-size", "font-style",
    "font-weight", "from", "gradientTransform", "gradientUnits", "height", "id",
    "in", "in2", "k1", "k2", "k3", "k4", "keyPoints", "keySplines", "keyTimes",
    "letter-spacing", "markerHeight", "markerWidth", "mask", "maskContentUnits",
    "maskUnits", "mode", "offset", "opacity", "operator", "orient", "paint-order",
    "path", "patternContentUnits", "patternTransform", "patternUnits", "points",
    "preserveAspectRatio", "primitiveUnits", "r", "radius", "refX", "refY",
    "repeatCount", "repeatDur", "restart", "result", "rotate", "rx", "ry",
    "spreadMethod", "startOffset", "stdDeviation", "stop-color", "stop-opacity",
    "stroke", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap",
    "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-width",
    "style", "text-anchor", "to", "transform", "type", "values", "vector-effect",
    "viewBox", "width", "x", "x1", "x2", "xChannelSelector", "y", "y1", "y2",
    "yChannelSelector",
}

# `style` is allowed because Iconify uses it for plain paint declarations, but
# anything that can pull in a URL is not.
STYLE_DENY = re.compile(r"(url\s*\(|expression\s*\(|@import|behavior\s*:)", re.I)


class RateLimited(Exception):
    """Upstream asked us to back off. Carries the server's Retry-After."""

    def __init__(self, retry_after):
        super().__init__("Iconify is rate limiting this host")
        self.retry_after = retry_after


def _atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%s.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(data)
    os.replace(tmp, path)


def _strip_ns(tag):
    return tag.split("}", 1)[1] if "}" in tag else tag


def _sanitize_body(body):
    """Return `body` with only allowlisted elements and attributes left.

    The markup comes from a third party and is injected into an authenticated
    page, so it is filtered once here — on the way into the cache — rather than
    trusted on every render.
    """
    wrapper = '<svg xmlns="%s" xmlns:xlink="%s">%s</svg>' % (SVG_NS, XLINK_NS, body)
    try:
        root = ET.fromstring(wrapper)
    except ET.ParseError:
        return ""

    def clean(el):
        for child in list(el):
            if _strip_ns(child.tag) not in ALLOWED_TAGS:
                el.remove(child)
            else:
                clean(child)
        for name in list(el.attrib):
            local = _strip_ns(name)
            value = el.attrib[name]
            # Local references (gradients, clip paths) are fine; remote ones and
            # javascript: are not.
            if local == "href":
                if not value.startswith("#"):
                    del el.attrib[name]
                continue
            if local not in ALLOWED_ATTRS or local.startswith("on"):
                del el.attrib[name]
                continue
            if local == "style" and STYLE_DENY.search(value):
                del el.attrib[name]
                continue
            if "javascript:" in value.replace(" ", "").lower():
                del el.attrib[name]

    clean(root)
    out = []
    if root.text:
        out.append(root.text)
    for child in root:
        out.append(ET.tostring(child, encoding="unicode"))
    return "".join(out).replace(' xmlns="%s"' % SVG_NS, "")


def _resolve(prefix_data, name, depth=0):
    """Resolve `name` within an Iconify prefix payload, following aliases.

    Returns the icon dict merged with any transform an alias applies, or None.
    """
    if depth > 8:
        return None
    icons = prefix_data.get("icons") or {}
    if name in icons:
        return dict(icons[name])
    aliases = prefix_data.get("aliases") or {}
    if name in aliases:
        alias = aliases[name]
        parent = _resolve(prefix_data, alias.get("parent", ""), depth + 1)
        if parent is None:
            return None
        # An alias may rotate or flip its parent; compose rather than overwrite.
        parent["rotate"] = (parent.get("rotate", 0) + alias.get("rotate", 0)) % 4
        for flip in ("hFlip", "vFlip"):
            if alias.get(flip):
                parent[flip] = not parent.get(flip, False)
        for key in ("width", "height", "left", "top"):
            if key in alias:
                parent[key] = alias[key]
        return parent
    return None


class IconCache:
    """Icon bodies, search results and the dashboard index, cached on disk."""

    def __init__(self, cache_dir, search_ttl=3600, tree_ttl=86400, max_icons=20000,
                 timeout=15):
        self.dir = cache_dir
        self.icons_dir = os.path.join(cache_dir, "iconify")
        self.meta_dir = os.path.join(cache_dir, "meta")
        self.search_ttl = search_ttl
        self.tree_ttl = tree_ttl
        self.max_icons = max_icons
        self.timeout = timeout
        self._lock = threading.Lock()
        self._cooldown_until = 0.0
        self._writes = 0
        os.makedirs(self.icons_dir, exist_ok=True)
        os.makedirs(self.meta_dir, exist_ok=True)

    # -- upstream ---------------------------------------------------------
    def _cooling_down(self):
        return time.time() < self._cooldown_until

    def _get_json(self, url, params=None):
        if self._cooling_down():
            raise RateLimited(int(self._cooldown_until - time.time()) + 1)
        resp = requests.get(url, params=params, timeout=self.timeout)
        if resp.status_code == 429:
            # Cloudflare's 1015 comes with a Retry-After; respect it for every
            # worker request until it expires instead of hammering back.
            try:
                wait = int(resp.headers.get("Retry-After", "300"))
            except ValueError:
                wait = 300
            wait = max(30, min(wait, 3600))
            with self._lock:
                self._cooldown_until = time.time() + wait
            raise RateLimited(wait)
        resp.raise_for_status()
        return resp.json()

    # -- icon bodies ------------------------------------------------------
    def _icon_path(self, prefix, name):
        return os.path.join(self.icons_dir, prefix, name + ".json")

    def _read_icon(self, prefix, name):
        try:
            with open(self._icon_path(prefix, name), "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def _write_icon(self, prefix, name, entry):
        _atomic_write(self._icon_path(prefix, name), json.dumps(entry))
        self._writes += 1
        if self._writes % 500 == 0:
            self._prune()

    def _prune(self):
        """Keep the cache bounded. Entries are ~400 bytes, so the default cap is
        a few megabytes; the oldest by mtime go first."""
        entries = []
        for root, _dirs, files in os.walk(self.icons_dir):
            for fn in files:
                if not fn.endswith(".json"):
                    continue
                full = os.path.join(root, fn)
                try:
                    entries.append((os.path.getmtime(full), full))
                except OSError:
                    continue
        if len(entries) <= self.max_icons:
            return
        entries.sort()
        for _mtime, full in entries[: len(entries) - self.max_icons]:
            try:
                os.remove(full)
            except OSError:
                pass

    def get_icons(self, refs):
        """Look up `prefix:name` refs, fetching whatever is not already cached.

        Returns (icons, missing, rate_limited, retry_after). A rate-limited fetch
        still returns everything the cache could answer, so a warm UI keeps
        working while upstream is refusing us.
        """
        wanted = {}
        icons = {}
        missing = []
        for ref in refs:
            if ":" not in ref:
                missing.append(ref)
                continue
            prefix, _, name = ref.partition(":")
            prefix, name = prefix.lower(), name.lower()
            if not SAFE_NAME.match(prefix) or not SAFE_NAME.match(name):
                missing.append(ref)
                continue
            cached = self._read_icon(prefix, name)
            if cached is not None:
                if cached.get("missing"):
                    missing.append(ref)
                else:
                    icons["%s:%s" % (prefix, name)] = cached
                continue
            wanted.setdefault(prefix, []).append(name)

        # One upstream request per prefix, however many icons it covers. A search
        # can span forty prefixes, so they go out concurrently rather than in a
        # queue forty round-trips deep.
        tasks = [
            (prefix, names[i:i + 100])
            for prefix, names in wanted.items()
            for i in range(0, len(names), 100)
        ]
        rate_limited = False
        retry_after = 0
        if tasks:
            workers = min(8, len(tasks))
            with futures.ThreadPoolExecutor(max_workers=workers) as pool:
                for found, gone, limited, wait in pool.map(
                    lambda t: self._fetch_prefix(*t), tasks
                ):
                    icons.update(found)
                    missing.extend(gone)
                    rate_limited = rate_limited or limited
                    retry_after = max(retry_after, wait)

        return icons, missing, rate_limited, retry_after

    def _fetch_prefix(self, prefix, names):
        """Fetch one prefix's worth of icons and write them through to disk."""
        try:
            data = self._get_json(
                "%s/%s.json" % (ICONIFY_API, prefix), {"icons": ",".join(names)}
            )
        except RateLimited as exc:
            return {}, ["%s:%s" % (prefix, n) for n in names], True, exc.retry_after
        except (requests.RequestException, ValueError):
            return {}, ["%s:%s" % (prefix, n) for n in names], False, 0

        found = {}
        gone = []
        dw, dh = data.get("width", 24), data.get("height", 24)
        for name in names:
            raw = _resolve(data, name)
            ref = "%s:%s" % (prefix, name)
            if raw is None or not raw.get("body"):
                # Remember the miss so a typo is not re-requested forever.
                self._write_icon(prefix, name, {"missing": True})
                gone.append(ref)
                continue
            entry = {
                "body": _sanitize_body(raw["body"]),
                "width": raw.get("width", dw),
                "height": raw.get("height", dh),
                "left": raw.get("left", 0),
                "top": raw.get("top", 0),
                "rotate": raw.get("rotate", 0),
                "hFlip": bool(raw.get("hFlip")),
                "vFlip": bool(raw.get("vFlip")),
            }
            self._write_icon(prefix, name, entry)
            found[ref] = entry
        return found, gone, False, 0

    # -- search and the dashboard index -----------------------------------
    def _cached_json(self, key, ttl, fetch):
        path = os.path.join(self.meta_dir, key + ".json")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                blob = json.load(fh)
            if time.time() - blob.get("t", 0) < ttl:
                return blob["data"], False
        except (OSError, ValueError, KeyError):
            blob = None

        try:
            data = fetch()
        except (RateLimited, requests.RequestException, ValueError):
            # Stale beats empty: a rate limit should not blank the picker.
            if blob and "data" in blob:
                return blob["data"], True
            raise
        _atomic_write(path, json.dumps({"t": time.time(), "data": data}))
        return data, False

    def search(self, query, prefix=None, limit=100):
        key = hashlib.sha1(
            ("%s|%s|%s" % (query, prefix or "", limit)).encode("utf-8")
        ).hexdigest()
        return self._cached_json(
            "search-" + key,
            self.search_ttl,
            lambda: self._get_json(
                "%s/search" % ICONIFY_API,
                {k: v for k, v in
                 (("query", query), ("limit", limit), ("prefix", prefix)) if v},
            ),
        )

    def dashboard_tree(self):
        def fetch():
            resp = requests.get(DASHBOARD_TREE_URL, timeout=self.timeout)
            resp.raise_for_status()
            return resp.json()

        return self._cached_json("dashboard-tree", self.tree_ttl, fetch)

    def stats(self):
        count = 0
        size = 0
        for root, _dirs, files in os.walk(self.icons_dir):
            for fn in files:
                if fn.endswith(".json"):
                    count += 1
                    try:
                        size += os.path.getsize(os.path.join(root, fn))
                    except OSError:
                        pass
        return {
            "icons": count,
            "bytes": size,
            "dir": self.dir,
            "cooling_down": self._cooling_down(),
        }
