"""Settings the user picks in the app rather than in compose.

Everything here has an environment-variable default; this file only records
what someone chose in the setup wizard or the Homepage connection dialog, so a
fresh install can be pointed at the right services.yaml from the browser
instead of by editing `.env` and recreating the container.

Stored as JSON in DATA_DIR next to the account database, so it persists across
container recreates with no extra volume.
"""

import json
import os
import tempfile
import threading

FILENAME = "settings.json"

_lock = threading.Lock()


class Settings:
    """A tiny JSON-backed dict. Reads are cached; writes are atomic."""

    def __init__(self, data_dir):
        self.path = os.path.join(data_dir, FILENAME)
        self._cache = None

    def all(self) -> dict:
        if self._cache is None:
            try:
                with open(self.path, "r", encoding="utf-8") as fh:
                    loaded = json.load(fh)
                self._cache = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError):
                self._cache = {}
        return dict(self._cache)

    def get(self, key, default=None):
        value = self.all().get(key)
        return default if value in (None, "") else value

    def set(self, **values):
        """Merge `values` in; a None value clears the key (back to the env default)."""
        with _lock:
            data = self.all()
            for key, value in values.items():
                if value is None:
                    data.pop(key, None)
                else:
                    data[key] = value
            self._write(data)
            self._cache = data
        return dict(data)

    def _write(self, data):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2, sort_keys=True)
                fh.write("\n")
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
