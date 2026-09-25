#!/usr/bin/env bash
# Say which version SemVer calls for, from the commits since the last release.
#
#   tools/next-version.sh           # the next version
#   tools/next-version.sh --why     # also list the commits that decided it
#
# The Conventional Commit types decide it: a "!" or a BREAKING CHANGE footer is
# MAJOR, a feat is MINOR, a fix, perf or revert is PATCH. Commits that change
# nothing a user sees (docs, test, ci, style, chore, build, refactor) do not
# force a release at all. docs/RELEASING.md has the judgment calls this cannot
# make: a schema change an older version can't read is MAJOR however the
# commit was typed.
set -euo pipefail
cd "$(dirname "$0")/.."

WHY=0
for arg in "$@"; do
    case "$arg" in --why) WHY=1 ;; *) echo "unknown: $arg" >&2; exit 1 ;; esac
done

# The commits to read start at the nearest release tag reachable from here: on
# a stable-X.Y branch that is the line's own last release, not whatever main has
# shipped since.
last=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*-*' HEAD 2>/dev/null || true)
# The number to bump is the highest release reachable from here, which is not
# always the nearest: the first releases were 1.0.0 to 1.1.2, then the line
# restarted at 0.1.3. A version never counts backwards, so 1.1.2 is the floor.
highest=$(git tag --merged HEAD -l 'v[0-9]*' --sort=-v:refname | grep -v -- - | head -1 || true)
if [ -z "$last" ]; then
    base=$(sed -n 's/^APP_VERSION = "\(.*\)"/\1/p' app.py)
    range="HEAD"
else
    base="${highest#v}"
    range="$last..HEAD"
fi
IFS=. read -r MA MI PA <<<"${base%%-*}"

log=$(git log --no-merges --format='%s%x1f%b%x1e' $range 2>/dev/null || true)
level=none
while IFS=$'\x1f' read -r -d $'\x1e' subject body; do
    subject="${subject#$'\n'}"
    [ -z "$subject" ] && continue
    type=$(printf '%s' "$subject" | sed -nE 's/^([a-z]+)(\([^)]*\))?(!?):.*/\1\3/p')
    if [[ "$type" == *'!' ]] || printf '%s' "$body" | grep -q '^BREAKING[ -]CHANGE:'; then
        this=major
    elif [ "$type" = feat ]; then
        this=minor
    elif [[ "$type" =~ ^(fix|perf|revert)$ ]]; then
        this=patch
    else
        this=none
    fi
    case "$level:$this" in
        *:major) level=major ;;
        none:minor|patch:minor) level=minor ;;
        none:patch) level=patch ;;
    esac
    [ "$WHY" = 1 ] && [ "$this" != none ] && printf '  %-5s %s\n' "$this" "$subject" >&2
done <<<"$log"

case "$level" in
    major) echo "$((MA + 1)).0.0" ;;
    minor) echo "$MA.$((MI + 1)).0" ;;
    patch) echo "$MA.$MI.$((PA + 1))" ;;
    none)  echo "Nothing since ${last:-the start} calls for a release." >&2; exit 2 ;;
esac
