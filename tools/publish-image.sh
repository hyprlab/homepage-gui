#!/usr/bin/env bash
# Build the Docker image for a tagged version and push it to Docker Hub.
#
#   tools/publish-image.sh 1.2.0          # pushes :1.2.0, :1.2 and :latest
#
# Builds from the tag, not the working tree, so what is pushed is exactly what
# was released. Multi-arch (amd64 and arm64) on a docker-container builder,
# which is created on first use.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: tools/publish-image.sh X.Y.Z}"
TAG="v$VERSION"
IMAGE="${IMAGE:-hyprlab/homepage-gui}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-hpgui-builder}"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "no tag $TAG" >&2; exit 1; }
tagged=$(git show "$TAG:app.py" | sed -n 's/^APP_VERSION = "\(.*\)"/\1/p')
[ "$tagged" = "$VERSION" ] || { echo "$TAG carries APP_VERSION $tagged, not $VERSION" >&2; exit 1; }
[[ "$VERSION" != *-* ]] || { echo "Homepage GUI has no prerelease channel; $VERSION is not a release version." >&2; exit 1; }

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    echo "Creating buildx builder $BUILDER (one-time)"
    docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null
    docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

minor="${VERSION%.*}"
tags=(-t "$IMAGE:$VERSION" -t "$IMAGE:$minor" -t "$IMAGE:latest")

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
git archive "$TAG" | tar -x -C "$src"

echo "Building $IMAGE for $VERSION ($PLATFORMS) from $TAG"
docker buildx build --builder "$BUILDER" --platform "$PLATFORMS" \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.revision=$(git rev-parse "$TAG^{commit}")" \
    --label "org.opencontainers.image.source=https://github.com/$IMAGE" \
    "${tags[@]}" --push "$src"

echo "Pushed: ${tags[*]//-t /}"
