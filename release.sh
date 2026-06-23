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
# Prereqs: gh (authenticated), docker logged in to Docker Hub as viibeware,
# and a matching "## [X.Y.Z]" section already written in CHANGELOG.md.

set -euo pipefail

IMAGE="viibeware/homepage-gui"
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
if ! grep -q "## \[$VERSION\]" CHANGELOG.md; then
  echo "error: no '## [$VERSION]' section in CHANGELOG.md — add release notes first." >&2
  exit 1
fi
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists." >&2
  exit 1
fi

echo "==> Releasing $TAG"

# --- 1. version bump + commit ---------------------------------------------
sed -i "s/^APP_VERSION = .*/APP_VERSION = \"$VERSION\"/" app.py

if ! git diff --quiet; then
  git add -A
  git commit -m "Release $TAG"
fi

# --- 2. tag + push + GitHub release ---------------------------------------
git tag -a "$TAG" -m "$TAG"
git push origin main
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
echo "    GitHub:     https://github.com/viibeware/homepage-gui/releases/tag/$TAG"
echo "    Docker Hub: docker pull $IMAGE:$VERSION"
