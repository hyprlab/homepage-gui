"""Read/write Homepage's services.yaml while preserving its structure.

Homepage's services.yaml is a list of single-key groups, each mapping to a
list of single-key services, each mapping to an arbitrary config dict:

    - Group Name:
        - Service Name:
            icon: ...
            href: ...
            description: ...
            ping: ...
            widget: { ... }   # arbitrary extra keys are preserved

We parse that into a flat editable model and serialize it back, keeping any
fields we don't have dedicated UI for (widgets, server, container, etc.).
"""

import io
import os
import shutil
import time
import datetime

import yaml

# Common fields we surface as first-class inputs, in Homepage's conventional
# output order. Everything else round-trips through the "advanced" editor.
COMMON_FIELDS = ["icon", "href", "description", "ping"]

HEADER = (
    "---\n"
    "# For configuration options and examples, please see:\n"
    "# https://gethomepage.dev/latest/configs/services\n"
)


class _OrderedDumper(yaml.SafeDumper):
    pass


def _represent_dict(dumper, data):
    # Preserve insertion order instead of sorting keys.
    return dumper.represent_mapping("tag:yaml.org,2002:map", data.items())


def _represent_none(dumper, _data):
    # Render None as an empty value (`href:`) rather than `href: null`,
    # matching how Homepage configs are usually hand-written.
    return dumper.represent_scalar("tag:yaml.org,2002:null", "")


def _represent_str(dumper, data):
    # Use block scalars for multi-line strings so they stay readable.
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_OrderedDumper.add_representer(dict, _represent_dict)
_OrderedDumper.add_representer(type(None), _represent_none)
_OrderedDumper.add_representer(str, _represent_str)


def parse(text):
    """YAML text -> editable model: {"groups": [...]}."""
    data = yaml.safe_load(text)
    groups = []
    if not isinstance(data, list):
        return {"groups": groups}

    for entry in data:
        if not isinstance(entry, dict) or not entry:
            continue
        # A group is a single-key mapping; tolerate stray extra keys by
        # taking the first and keeping the rest as raw.
        gname = next(iter(entry))
        gval = entry[gname]

        if isinstance(gval, list):
            services = []
            for item in gval:
                if not isinstance(item, dict) or not item:
                    continue
                sname = next(iter(item))
                sconf = item[sname]
                if sconf is None:
                    sconf = {}
                services.append({"name": str(sname), "config": sconf})
            groups.append({"name": str(gname), "type": "services", "services": services})
        else:
            # Group-level settings or unexpected shape: preserve verbatim.
            groups.append({"name": str(gname), "type": "raw", "raw": gval})

    return {"groups": groups}


def _order_config(cfg):
    """Emit common fields first in Homepage's conventional order, then the rest."""
    if not isinstance(cfg, dict):
        return cfg
    ordered = {}
    for key in COMMON_FIELDS:
        if key in cfg:
            ordered[key] = cfg[key]
    for key, val in cfg.items():
        if key not in ordered:
            ordered[key] = val
    return ordered


def serialize(model):
    """Editable model -> YAML text (with Homepage header comment)."""
    out = []
    for g in model.get("groups", []):
        name = g.get("name", "")
        if g.get("type") == "raw":
            out.append({name: g.get("raw")})
            continue
        services = []
        for s in g.get("services", []):
            cfg = _order_config(s.get("config") or {})
            services.append({s.get("name", ""): cfg})
        out.append({name: services})

    body = yaml.dump(
        out,
        Dumper=_OrderedDumper,
        default_flow_style=False,
        allow_unicode=True,
        sort_keys=False,
        width=4096,
    )
    return HEADER + body


def validate(text):
    """Ensure generated text re-parses. Returns (ok, error)."""
    try:
        yaml.safe_load(text)
        return True, None
    except yaml.YAMLError as exc:
        return False, str(exc)


class ServicesStore:
    def __init__(self, path, backup_dir, keep=40, keep_days=14):
        self.path = path
        self.backup_dir = backup_dir
        self.keep = keep  # hard cap on number of backups (0 = unlimited)
        self.keep_days = keep_days  # auto-purge backups older than this (0 = forever)
        os.makedirs(self.backup_dir, exist_ok=True)

    def load(self):
        # Purge expired backups whenever the config is read (i.e. on page load),
        # so old backups age out even without a new save.
        self.prune()
        with io.open(self.path, "r", encoding="utf-8") as fh:
            text = fh.read()
        model = parse(text)
        model["path"] = self.path
        model["mtime"] = os.path.getmtime(self.path)
        return model

    def save(self, model):
        text = serialize(model)
        ok, err = validate(text)
        if not ok:
            raise ValueError("Generated YAML failed to parse: %s" % err)

        backup_name = self._backup()
        tmp = self.path + ".tmp"
        with io.open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, self.path)
        self._prune()
        return backup_name

    def _backup(self):
        if not os.path.exists(self.path):
            return None
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        name = "services-%s.yaml" % stamp
        dest = os.path.join(self.backup_dir, name)
        # Avoid clobbering within the same second.
        i = 1
        while os.path.exists(dest):
            name = "services-%s-%d.yaml" % (stamp, i)
            dest = os.path.join(self.backup_dir, name)
            i += 1
        shutil.copy2(self.path, dest)
        return name

    def prune(self):
        """Delete backups older than keep_days, then enforce the count cap.

        `list_backups()` returns newest first, so age handles the time limit and
        the index handles the count cap.
        """
        backups = self.list_backups()
        now = time.time()
        max_age = self.keep_days * 86400 if self.keep_days else None
        for i, b in enumerate(backups):
            too_old = max_age is not None and (now - b["mtime"]) > max_age
            over_cap = bool(self.keep) and i >= self.keep
            if too_old or over_cap:
                try:
                    os.remove(os.path.join(self.backup_dir, b["name"]))
                except OSError:
                    pass

    # Backwards-compatible internal alias.
    _prune = prune

    def list_backups(self):
        items = []
        for name in os.listdir(self.backup_dir):
            if not name.endswith(".yaml"):
                continue
            full = os.path.join(self.backup_dir, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            items.append({"name": name, "mtime": st.st_mtime, "size": st.st_size})
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return items

    def backup_text(self, name):
        # Guard against path traversal.
        safe = os.path.basename(name)
        full = os.path.join(self.backup_dir, safe)
        if not os.path.isfile(full):
            raise FileNotFoundError(name)
        with io.open(full, "r", encoding="utf-8") as fh:
            return fh.read()

    def restore(self, name):
        text = self.backup_text(name)
        ok, err = validate(text)
        if not ok:
            raise ValueError("Backup is not valid YAML: %s" % err)
        # Back up current state first, then overwrite.
        self._backup()
        tmp = self.path + ".tmp"
        with io.open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, self.path)
        self._prune()
