"""Find the Homepage install and its services.yaml, without asking the user.

The GUI runs in a container, so "where is services.yaml?" has two answers: the
path *inside this container* (the only one we can actually open) and the path
*on the host* (the one the user typed into their compose file). We work both
out from two independent sources:

* **The Docker socket.** If it's mounted we ask the Engine API which container
  is Homepage, which host directory it has bound to ``/app/config``, and which
  host directories are bound into *us*. Overlapping the two translates
  Homepage's host config dir into a path this container can open.
* **A filesystem scan.** Every real (non-pseudo) mount visible in this
  container is walked looking for a ``services.yaml`` sitting next to the rest
  of Homepage's config files.

Either source alone is useful: the scan finds the file whatever mount point it
was given, and the Docker half still names the exact host path to mount when
the config dir isn't shared with us yet.
"""

import http.client
import json
import os
import re
import socket
import time

DOCKER_SOCK = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")

# Homepage's config directory holds these next to services.yaml. Finding them
# alongside a candidate is what separates "the real thing" from a stray YAML.
MARKER_FILES = (
    "settings.yaml",
    "widgets.yaml",
    "bookmarks.yaml",
    "docker.yaml",
    "kubernetes.yaml",
    "proxmox.yaml",
    "custom.css",
    "custom.js",
)
SERVICES_NAMES = ("services.yaml", "services.yml")
_MARKER_RANK = {name: i for i, name in enumerate(MARKER_FILES)}


def _rank_markers(names):
    """Most telling markers first — settings.yaml says more than custom.css."""
    return sorted(names, key=lambda n: _MARKER_RANK.get(n, len(MARKER_FILES)))

# Where Homepage keeps its config inside its own container.
HOMEPAGE_CONFIG_DEST = "/app/config"

# Filesystems that can't hold a user's config directory.
PSEUDO_FS = {
    "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs", "debugfs",
    "devpts", "devtmpfs", "efivarfs", "fusectl", "hugetlbfs", "mqueue", "nsfs",
    "overlay", "proc", "pstore", "ramfs", "securityfs", "squashfs", "sysfs",
    "tmpfs", "tracefs",
}

# Pruned wherever they turn up: huge, or guaranteed not to hold a config dir.
NOISE_DIRS = {
    ".cache", ".git", ".npm", ".yarn", "__pycache__", "lost+found",
    "node_modules", "site-packages", "proc", "sys", "dev",
}
# Pruned only at the top level of a scan root that looks like a host root
# filesystem (someone mounting `/` at `/host` shouldn't cost us a minute).
SYSTEM_TOP_DIRS = {
    "bin", "boot", "lib", "lib32", "lib64", "libx32", "proc", "run", "sbin",
    "snap", "sys", "usr",
}

MAX_DEPTH = 6
MAX_DIRS = 40000
TIME_BUDGET = 6.0


# ---------------------------------------------------------------------------
# Docker Engine API over the unix socket (stdlib only — no docker-py)
# ---------------------------------------------------------------------------
class DockerError(RuntimeError):
    pass


class _UnixHTTPConnection(http.client.HTTPConnection):
    """Talk HTTP over a unix socket using only the stdlib."""

    def __init__(self, sock_path, timeout=30):
        super().__init__("localhost", timeout=timeout)
        self._sock_path = sock_path
        self._timeout = timeout

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self._timeout)
        s.connect(self._sock_path)
        self.sock = s


class Docker:
    """The handful of Engine API calls this app needs."""

    def __init__(self, sock_path=DOCKER_SOCK, timeout=15):
        self.sock_path = sock_path
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return os.path.exists(self.sock_path)

    def request(self, method, path):
        if not self.available:
            raise DockerError(
                "Docker socket not available — mount %s into this container to "
                "enable Homepage detection and one-click restarts." % self.sock_path
            )
        conn = _UnixHTTPConnection(self.sock_path, self.timeout)
        try:
            conn.request(method, path)
            resp = conn.getresponse()
            return resp.status, resp.read()
        except (OSError, http.client.HTTPException) as exc:
            raise DockerError("Docker socket error: %s" % exc) from exc
        finally:
            conn.close()

    def get_json(self, path):
        status, body = self.request("GET", path)
        if status != 200:
            raise DockerError(
                "Docker API returned %s for %s: %s"
                % (status, path, body.decode("utf-8", "replace")[:200])
            )
        try:
            return json.loads(body.decode("utf-8", "replace"))
        except ValueError as exc:
            raise DockerError("Unreadable Docker API response: %s" % exc) from exc

    def containers(self):
        return self.get_json("/containers/json?all=1")

    def inspect(self, ident):
        return self.get_json("/containers/%s/json" % ident)

    def restart(self, name, timeout=5):
        status, body = self.request("POST", "/containers/%s/restart?t=%d" % (name, timeout))
        if status == 404:
            raise DockerError("Container '%s' not found." % name)
        if status != 204:
            raise DockerError(
                "Docker API returned %s: %s" % (status, body.decode("utf-8", "replace"))
            )


def self_container_id():
    """This container's id, for asking Docker what's mounted into us."""
    host = os.environ.get("HOSTNAME", "").strip()
    if re.fullmatch(r"[0-9a-f]{12,64}", host):
        return host
    # Fall back to the id embedded in the container's own mount/cgroup paths.
    for source in ("/proc/self/mountinfo", "/proc/self/cgroup"):
        try:
            with open(source, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            continue
        match = re.search(r"(?:containers|docker[/-])([0-9a-f]{64})", text)
        if match:
            return match.group(1)
    return host or None


def _mounts_of(container):
    """[(host source, container destination)] for a container JSON blob."""
    out = []
    for m in container.get("Mounts") or []:
        src, dest = m.get("Source"), m.get("Destination")
        if src and dest:
            out.append({"source": src.rstrip("/") or "/", "destination": dest.rstrip("/") or "/"})
    return out


def _looks_like_homepage(container):
    """Score how likely a container is gethomepage/homepage."""
    image = (container.get("Image") or "").lower()
    names = [n.lstrip("/").lower() for n in (container.get("Names") or [])]
    labels = container.get("Labels") or {}
    score = 0
    if "gethomepage/homepage" in image:
        score += 100
    elif "homepage" in image:
        score += 40
    if any("homepage" in n for n in names):
        score += 25
    if any(d["destination"] == HOMEPAGE_CONFIG_DEST for d in _mounts_of(container)):
        score += 40
    source = (labels.get("org.opencontainers.image.source") or "").lower()
    if "gethomepage/homepage" in source:
        score += 60
    return score


def docker_survey(docker=None):
    """What Docker can tell us: our own mounts, and Homepage's config dir.

    Never raises — a missing or unreadable socket just means less information.
    """
    docker = docker or Docker()
    result = {
        "available": docker.available,
        "error": None,
        "self_mounts": [],
        "homepage": None,
        "other_candidates": [],
    }
    if not docker.available:
        return result
    try:
        me = self_container_id()
        if me:
            try:
                result["self_mounts"] = _mounts_of(docker.inspect(me))
            except DockerError:
                pass  # not fatal: we just can't translate host paths

        ranked = []
        for c in docker.containers():
            # This app's own container has "homepage" in its name; it is not
            # the dashboard we're looking for.
            if me and (c.get("Id") or "").startswith(me[:12]):
                continue
            score = _looks_like_homepage(c)
            if score < 40:
                continue
            config_dir = next(
                (m["source"] for m in _mounts_of(c) if m["destination"] == HOMEPAGE_CONFIG_DEST),
                None,
            )
            ranked.append(
                {
                    "id": (c.get("Id") or "")[:12],
                    "name": (c.get("Names") or ["/?"])[0].lstrip("/"),
                    "image": c.get("Image"),
                    "state": c.get("State"),
                    "host_config_dir": config_dir,
                    "score": score + (20 if config_dir else 0),
                }
            )
        ranked.sort(key=lambda x: x["score"], reverse=True)
        if ranked:
            result["homepage"] = ranked[0]
            result["other_candidates"] = ranked[1:4]
    except DockerError as exc:
        result["error"] = str(exc)
    return result


def host_to_local(host_path, self_mounts):
    """Translate a host path into a path inside this container, if it's mounted."""
    if not host_path:
        return None
    host_path = host_path.rstrip("/") or "/"
    best = None
    for m in self_mounts:
        src = m["source"]
        if host_path == src:
            rest = ""
        elif host_path.startswith(src.rstrip("/") + "/"):
            rest = host_path[len(src.rstrip("/")) :]
        else:
            continue
        # Longest matching source wins (nested mounts).
        if best is None or len(src) > len(best[0]):
            best = (src, os.path.normpath(m["destination"] + rest))
    return best[1] if best else None


def local_to_host(local_path, self_mounts):
    """The reverse: our path -> the host path a user would recognise."""
    if not local_path:
        return None
    local_path = local_path.rstrip("/") or "/"
    best = None
    for m in self_mounts:
        dest = m["destination"]
        if local_path == dest:
            rest = ""
        elif local_path.startswith(dest.rstrip("/") + "/"):
            rest = local_path[len(dest.rstrip("/")) :]
        else:
            continue
        if best is None or len(dest) > len(best[0]):
            best = (dest, os.path.normpath(m["source"] + rest))
    return best[1] if best else None


# ---------------------------------------------------------------------------
# Filesystem scan
# ---------------------------------------------------------------------------
def _real_mount_points():
    """Directories in this container backed by a real filesystem (bind mounts)."""
    points = []
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return points
    for line in lines:
        head, _, tail = line.partition(" - ")
        left, right = head.split(), tail.split()
        if len(left) < 5 or not right:
            continue
        target = left[4].replace("\\040", " ")
        if right[0] in PSEUDO_FS or target == "/":
            continue
        # /etc/hosts and friends are bind-mounted *files*, and the Docker
        # socket is a socket; only directories are worth walking.
        if os.path.isdir(target):
            points.append(target)
    return points


def scan_roots(extra=()):
    """Every distinct place worth walking, outermost first."""
    seen, roots = set(), []
    candidates = list(extra) + [
        os.environ.get("HOMEPAGE_CONFIG_DIR") or "/config",
        "/app/config",
        "/homepage",
        "/host",  # optional read-only host mount, for whole-host discovery
    ]
    candidates += _real_mount_points()
    for raw in candidates:
        if not raw:
            continue
        try:
            path = os.path.realpath(raw)
        except OSError:
            continue
        if not os.path.isdir(path) or path in seen:
            continue
        seen.add(path)
        roots.append(path)
    # Drop roots already covered by an outer root.
    roots.sort(key=len)
    kept = []
    for path in roots:
        if any(path == k or path.startswith(k.rstrip("/") + "/") for k in kept):
            continue
        kept.append(path)
    return kept


def _looks_like_fs_root(path):
    return os.path.isdir(os.path.join(path, "etc")) and os.path.isdir(os.path.join(path, "usr"))


def scan_for_services(roots, exclude_dirs=(), deadline=None):
    """Walk `roots` for services.yaml files. Returns [(path, marker filenames)]."""
    deadline = deadline or (time.monotonic() + TIME_BUDGET)
    exclude = {os.path.realpath(d).rstrip("/") for d in exclude_dirs if d}
    found, visited = [], 0

    for root in roots:
        prune_system = _looks_like_fs_root(root)
        root_depth = root.rstrip("/").count("/")
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            visited += 1
            if visited > MAX_DIRS or time.monotonic() > deadline:
                dirnames[:] = []
                break

            depth = dirpath.rstrip("/").count("/") - root_depth
            if depth >= MAX_DEPTH:
                dirnames[:] = []

            keep = []
            for name in dirnames:
                full = os.path.join(dirpath, name)
                if name in NOISE_DIRS or full.rstrip("/") in exclude:
                    continue
                # Our own dot-folders, and anything hidden except .config.
                if name.startswith(".") and name != ".config":
                    continue
                if prune_system and depth == 0 and name in SYSTEM_TOP_DIRS:
                    continue
                if os.path.join(dirpath, name).endswith("/var/lib/docker"):
                    continue
                keep.append(name)
            dirnames[:] = keep

            names = set(filenames)
            for candidate in SERVICES_NAMES:
                if candidate in names:
                    found.append(
                        (
                            os.path.join(dirpath, candidate),
                            _rank_markers(names.intersection(MARKER_FILES)),
                        )
                    )
    return found


# ---------------------------------------------------------------------------
# Putting it together
# ---------------------------------------------------------------------------
def _writable(path):
    """Can we write this file, or create it where it doesn't exist yet?"""
    if os.path.exists(path):
        return os.access(path, os.W_OK)
    parent = os.path.dirname(path) or "/"
    return os.path.isdir(parent) and os.access(parent, os.W_OK)


def _describe(path, markers=(), sources=(), host_path=None):
    exists = os.path.isfile(path)
    entry = {
        "path": path,
        "dir": os.path.dirname(path),
        "exists": exists,
        "writable": _writable(path),
        "markers": list(markers),
        "sources": list(sources),
        "host_path": host_path,
        "size": None,
        "mtime": None,
    }
    if exists:
        try:
            st = os.stat(path)
            entry["size"], entry["mtime"] = st.st_size, st.st_mtime
        except OSError:
            pass
    return entry


def _score(entry, current_path):
    score = 0
    if entry["exists"]:
        score += 30
    if "docker" in entry["sources"]:
        score += 45
    if "current" in entry["sources"]:
        score += 25
    if "default" in entry["sources"]:
        score += 5
    score += min(len(entry["markers"]), 3) * 15
    if entry["writable"]:
        score += 10
    lowered = entry["path"].lower()
    if "backup" in lowered or "/temp" in lowered or "example" in lowered:
        score -= 40
    if entry["path"] == current_path:
        score += 15
    return score


def _reason(entry):
    """One line explaining why a candidate is in the list."""
    bits = []
    if "docker" in entry["sources"]:
        bits.append("Homepage's own config mount")
    if entry["markers"]:
        bits.append("sits next to " + ", ".join(entry["markers"][:3]))
    if "current" in entry["sources"]:
        bits.append("currently configured")
    elif "default" in entry["sources"] and not bits:
        bits.append("the default location")
    if not entry["exists"]:
        bits.append("file doesn't exist yet")
    elif not entry["writable"]:
        bits.append("read-only — check permissions")
    return " · ".join(bits) or "found by scanning mounted folders"


def detect(current_path=None, default_path=None, exclude_dirs=(), docker=None):
    """Everything we can work out about where services.yaml lives.

    Returns candidates ranked best-first, plus what Docker told us — including
    the *host* path of Homepage's config dir when it isn't mounted into this
    container, which is exactly the thing the user needs to fix their compose.
    """
    started = time.monotonic()
    survey = docker_survey(docker)
    self_mounts = survey["self_mounts"]

    # path -> {markers, sources}
    seen = {}

    def add(path, markers=(), source=None):
        if not path:
            return
        path = os.path.normpath(path)
        entry = seen.setdefault(path, {"markers": set(), "sources": set()})
        entry["markers"].update(markers)
        if source:
            entry["sources"].add(source)


    # 1. What Docker says Homepage is using, translated into our namespace.
    homepage = survey["homepage"]
    homepage_local_dir = None
    if homepage and homepage.get("host_config_dir"):
        homepage_local_dir = host_to_local(homepage["host_config_dir"], self_mounts)
        if homepage_local_dir:
            local = os.path.join(homepage_local_dir, "services.yaml")
            markers = []
            if os.path.isdir(homepage_local_dir):
                try:
                    markers = _rank_markers(set(os.listdir(homepage_local_dir)) & set(MARKER_FILES))
                except OSError:
                    markers = []
            add(local, markers, "docker")

    # 2. Anything already configured, and the compiled-in default.
    if current_path:
        add(current_path, (), "current")
    if default_path:
        add(default_path, (), "default")

    # 3. Walk the mounts.
    roots = scan_roots()
    deadline = started + TIME_BUDGET
    for path, markers in scan_for_services(roots, exclude_dirs, deadline):
        add(path, markers, "scan")

    candidates = []
    for path, meta in seen.items():
        entry = _describe(
            path,
            _rank_markers(meta["markers"]),
            sorted(meta["sources"]),
            host_path=local_to_host(path, self_mounts),
        )
        # A configured-but-absent path is only noise unless it's the default.
        if not entry["exists"] and not ({"current", "default", "docker"} & set(entry["sources"])):
            continue
        entry["score"] = _score(entry, current_path)
        entry["reason"] = _reason(entry)
        candidates.append(entry)

    candidates.sort(key=lambda c: (-c["score"], c["path"]))

    # Homepage is running with a config dir we can't see: say so precisely.
    unmounted = None
    if homepage and homepage.get("host_config_dir") and not homepage_local_dir:
        unmounted = homepage["host_config_dir"]

    return {
        "candidates": candidates,
        "docker": {
            "available": survey["available"],
            "error": survey["error"],
            "homepage": homepage,
            "other_candidates": survey["other_candidates"],
            "self_mounts": self_mounts,
        },
        "unmounted_host_config_dir": unmounted,
        "scanned_roots": roots,
        "took": round(time.monotonic() - started, 2),
    }
