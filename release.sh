#!/usr/bin/env bash
#
# release.sh — ship homepage-gui in one shot.
#
# Does two independent things for a given version:
#   1. GitHub  — bump APP_VERSION, commit, tag vX.Y.Z, push, and cut a release.
#   2. Docker Hub — build & push a multi-arch (amd64+arm64) image directly from
#                   local, tagged X.Y.Z, X.Y, and latest.
#
# Usage:
#   ./release.sh 1.1.3
#
# Prereqs: gh (authenticated), docker logged in to Docker Hub as hyprlab,
# and a matching "## [X.Y.Z]" section already written in CHANGELOG.md.

set -euo pipefail

IMAGE="hyprlab/homepage-gui"
BUILDER="hpgui-builder"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version>   e.g. $0 1.1.3" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must look like X.Y.Z (got '$VERSION')" >&2
  exit 1
fi

TAG="v$VERSION"
MAJOR_MINOR="${VERSION%.*}"

cd "$(dirname "$0")"

# --- sanity checks ---------------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "error: releases are cut from main (currently on '$BRANCH')." >&2
  exit 1
fi
if ! grep -q "## \[$VERSION\]" CHANGELOG.md; then
  echo "error: no '## [$VERSION]' section in CHANGELOG.md — add release notes first." >&2
  exit 1
fi
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists." >&2
  exit 1
fi

# Sync with the remote *before* committing anything. A push rejected later
# (because someone pushed to main meanwhile) would otherwise leave a release
# commit and tag stranded locally, needing a hand-rebase and retag.
echo "==> Fetching origin"
git fetch --quiet origin
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists on origin." >&2
  exit 1
fi
BEHIND="$(git rev-list --count HEAD..origin/main)"
AHEAD="$(git rev-list --count origin/main..HEAD)"
if [[ "$BEHIND" -gt 0 ]]; then
  if [[ "$AHEAD" -gt 0 ]]; then
    echo "error: main and origin/main have diverged ($AHEAD local, $BEHIND remote commit(s))." >&2
    echo "       Reconcile first:  git pull --rebase origin main" >&2
    exit 1
  fi
  echo "==> Behind origin/main by $BEHIND commit(s) — fast-forwarding"
  # Refuses (leaving the tree untouched) if uncommitted work would be clobbered.
  if ! git merge --ff-only origin/main; then
    echo "error: could not fast-forward — commit or stash the conflicting changes." >&2
    exit 1
  fi
fi

echo "==> Releasing $TAG"

# --- 1. version bump + commit ---------------------------------------------
sed -i "s/^APP_VERSION = .*/APP_VERSION = \"$VERSION\"/" app.py

if ! git diff --quiet; then
  git add -A
  git commit -m "Release $TAG"
fi

# --- 2. push + tag + GitHub release ---------------------------------------
# Push the commit first: if main moved under us despite the check above, the
# rejection happens before there's a tag to clean up.
git push origin main
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"

# Extract this version's notes from CHANGELOG.md (everything between its
# header and the next "## " header) for the GitHub release body.
NOTES="$(awk -v v="## [$VERSION]" '
  $0 ~ v {grab=1; next}
  grab && /^## / {exit}
  grab {print}
' CHANGELOG.md)"

gh release create "$TAG" \
  --title "$TAG" \
  --notes "${NOTES}

**Docker:** \`docker pull $IMAGE:$VERSION\` (also tagged \`latest\`)"

# --- 3. Docker Hub multi-arch push ----------------------------------------
# Ensure a docker-container builder exists for multi-arch pushes.
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "==> Creating buildx builder '$BUILDER' (one-time)"
  docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

docker buildx build \
  --builder "$BUILDER" \
  --platform linux/amd64,linux/arm64 \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:$MAJOR_MINOR" \
  -t "$IMAGE:latest" \
  --push .

echo
echo "==> Shipped $TAG"
echo "    GitHub:     https://github.com/hyprlab/homepage-gui/releases/tag/$TAG"
echo "    Docker Hub: docker pull $IMAGE:$VERSION"
