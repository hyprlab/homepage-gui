#!/usr/bin/env bash
# Print the GitHub release body for one version.
#
#   tools/release-notes.sh 1.3.0 > /tmp/notes.md
#
# The body is that version's CHANGELOG section and nothing else. Never hand
# CHANGELOG.md itself to `gh release create`: every release page would carry
# the whole history.
#
# With the tag pushed, it appends a "What's changed" list against the previous
# release and a compare link. "Previous" is by date, not by number: the first
# releases were 1.0.0 to 1.1.2, and the line restarted at 0.1.3 after them.
#
# GitHub keeps every line break in a release body, so paragraphs and list items
# are unwrapped to one line each. An @handle keeps its @ only if the person is
# in data/CONTRIBUTORS: an @ notifies someone and reads as authorship, so it is
# for people whose work is in the release, not for whoever reported the bug.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: tools/release-notes.sh X.Y.Z}"
TAG="v$VERSION"

{
python3 - "$VERSION" <<'PY'
import re, sys, pathlib
version = sys.argv[1]
text = pathlib.Path("CHANGELOG.md").read_text(encoding="utf-8")
m = re.search(r"^##\s+\[?" + re.escape(version) + r"\]?[^\n]*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
if not m:
    sys.exit(f"CHANGELOG.md has no section for {version}.")
out, buf = [], []
def flush():
    if buf:
        out.append(" ".join(buf)); buf.clear()
for line in m.group(1).strip().splitlines():
    s = line.strip()
    if not s:
        flush(); out.append("")
    elif re.match(r"^([-*]|\d+\.|#+)\s", s):
        flush(); buf.append(s)
    else:
        buf.append(s)
flush()
print(re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip())
PY

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    prev=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*-*' "$TAG^" 2>/dev/null || true)
    if [ -n "$prev" ]; then
        echo
        echo "### What's changed"
        echo
        git log --no-merges --format='- %s' "$prev..$TAG" | grep -v '^- chore(release)' || true
        repo=$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#' || true)
        if [ -n "$repo" ]; then
            echo
            echo "**Full changes:** https://github.com/$repo/compare/$prev...$TAG"
        fi
    fi
fi
} | python3 -c '
import re, sys, pathlib
p = pathlib.Path("data/CONTRIBUTORS")
known = set()
if p.exists():
    for line in p.read_text(encoding="utf-8").splitlines():
        m = re.search(r"@([A-Za-z0-9-]+)", line)
        if m and not line.lstrip().startswith("#"):
            known.add(m.group(1).lower())
text = sys.stdin.read()
text = re.sub(r"(?<![\w/])@([A-Za-z0-9-]+)",
              lambda m: m.group(0) if m.group(1).lower() in known else m.group(1), text)
sys.stdout.write(text)
'
