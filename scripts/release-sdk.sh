#!/usr/bin/env bash
set -euo pipefail

# release-sdk.sh — Build SDK and create a git tag installable via:
#   npm install github:agoramesh-ai/agoramesh#sdk-v<version>
#
# Usage:
#   ./scripts/release-sdk.sh           # tags as sdk-v<version from package.json>
#   ./scripts/release-sdk.sh 0.2.0     # tags as sdk-v0.2.0
#
# How it works:
#   The SDK lives in sdk/ but npm requires package.json at the repo root for
#   git-based installs. This script creates a temporary orphan commit containing
#   only the built SDK files at the root level, tags it, and pushes the tag.
#   Your main branch is not affected.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK_DIR="$REPO_ROOT/sdk"

# Determine version
if [[ $# -ge 1 ]]; then
  VERSION="$1"
else
  VERSION=$(node -p "require('$SDK_DIR/package.json').version")
fi

TAG="sdk-v${VERSION}"

echo "==> Releasing @agoramesh/sdk as ${TAG}"

# Check for uncommitted changes
if ! git -C "$REPO_ROOT" diff --quiet HEAD -- sdk/; then
  echo "WARNING: You have uncommitted changes in sdk/. They will be included in the build."
  read -p "Continue? [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# Check if tag already exists
if git -C "$REPO_ROOT" rev-parse "$TAG" >/dev/null 2>&1; then
  echo "ERROR: Tag ${TAG} already exists."
  echo "  To re-release, first delete it:  git tag -d ${TAG} && git push origin :refs/tags/${TAG}"
  exit 1
fi

# 1. Build the SDK
echo "==> Building SDK..."
cd "$SDK_DIR"
npm run clean
npm run build
echo "    Build OK"

# 2. Create a temporary working directory
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# 3. Copy built SDK files to temp dir (flat structure — package.json at root)
echo "==> Preparing release tree..."
cp "$SDK_DIR/package.json" "$TMPDIR/"
cp -r "$SDK_DIR/dist" "$TMPDIR/dist"
[ -f "$SDK_DIR/README.md" ] && cp "$SDK_DIR/README.md" "$TMPDIR/"
[ -f "$REPO_ROOT/LICENSE" ] && cp "$REPO_ROOT/LICENSE" "$TMPDIR/"

# Strip dev-only scripts and devDependencies from package.json
node -e "
  const pkg = require('$TMPDIR/package.json');
  delete pkg.devDependencies;
  pkg.scripts = {};
  require('fs').writeFileSync('$TMPDIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# 4. Create orphan commit with only SDK files
echo "==> Creating tag ${TAG}..."
cd "$TMPDIR"
git init --quiet
git add -A
git commit --quiet -m "sdk release ${VERSION}"

# Tag the commit
COMMIT=$(git rev-parse HEAD)

# Now go back to the real repo and create the tag pointing to this tree
# We need to import the commit object into the real repo
cd "$REPO_ROOT"

# Import the tree from temp repo into our repo
TREE=$(git -C "$TMPDIR" rev-parse HEAD^{tree})

# Create the tree in our repo by fetching from the temp repo
git fetch --quiet "$TMPDIR" HEAD

# Tag the fetched commit
FETCHED=$(git rev-parse FETCH_HEAD)
git tag -a "$TAG" "$FETCHED" -m "SDK release ${VERSION}

Install with:
  npm install github:agoramesh-ai/agoramesh#${TAG}"

echo "==> Tag ${TAG} created locally"

# 5. Push the tag
echo "==> Pushing tag to origin..."
git push origin "$TAG"

echo ""
echo "=== Done! ==="
echo ""
echo "Install with:"
echo "  npm install github:agoramesh-ai/agoramesh#${TAG}"
echo ""
echo "Update existing install:"
echo "  npm install github:agoramesh-ai/agoramesh#${TAG}"
echo ""
