#!/usr/bin/env bash
# Set the version and turn the changelog's Unreleased section into its section.
#
#   tools/bump-version.sh 1.3.0
#
# It edits APP_VERSION in app.py and CHANGELOG.md and runs check-docs. It does not
# commit, tag or push: docs/RELEASING.md is the procedure around it.
set -euo pipefail
cd "$(dirname "$0")/.."

INIT=app.py
CURRENT=$(sed -n 's/^APP_VERSION = "\(.*\)"/\1/p' "$INIT")
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "usage: tools/bump-version.sh X.Y.Z   (current: $CURRENT)" >&2
    exit 1
fi

python3 - "$CURRENT" "$VERSION" <<'PY'
import re, sys, datetime, pathlib
current, version = sys.argv[1], sys.argv[2]
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$")
if not SEMVER.match(version):
    sys.exit(f"'{version}' is not a SemVer version (https://semver.org/).")

import importlib.util
spec = importlib.util.spec_from_file_location("check_docs", "tools/check-docs.py")
cd = importlib.util.module_from_spec(spec); spec.loader.exec_module(cd)
if cd.sort_key(version) <= cd.sort_key(current):
    sys.exit(f"{version} is not newer than {current}. A version never counts backwards.")

path = pathlib.Path("CHANGELOG.md")
text = path.read_text(encoding="utf-8")
m = re.search(r"^## Unreleased[ \t]*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
if not m:
    sys.exit("CHANGELOG.md has no '## Unreleased' section.")
if not m.group(1).strip():
    sys.exit("The Unreleased section is empty. Write the entries before bumping.")
today = datetime.date.today().isoformat()
new = f"## Unreleased\n\n## [{version}] - {today}\n\n{m.group(1).strip()}\n\n"
path.write_text(text[:m.start()] + new + text[m.end():], encoding="utf-8")
PY

sed -i "s/^APP_VERSION = \".*\"/APP_VERSION = \"$VERSION\"/" "$INIT"
echo "$CURRENT -> $VERSION ($INIT, CHANGELOG.md)"
python3 tools/check-docs.py
