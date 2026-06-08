#!/usr/bin/env bash
# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.
#
# Bump VERSION, stamp CHANGELOG with today's date, commit, tag, push.
# GitHub Actions takes over from the pushed tag (builds images, publishes
# the GitHub Release with manifest.json attached).
#
#   ./scripts/release.sh 1.0.0          # stable release
#   ./scripts/release.sh 1.0.0-rc.1     # prerelease
#   ./scripts/release.sh --dry-run 1.0.0
#
# Refuses to run if:
#   - current branch isn't main
#   - working tree is dirty or has untracked files
#   - the tag already exists locally or on origin
#   - CHANGELOG.md has no `## [Unreleased]` section to convert
#
# The CHANGELOG transformation:
#   ## [Unreleased]      ─►  ## [Unreleased]   (fresh, empty body)
#                            …
#                            ## [X.Y.Z] - YYYY-MM-DD   (former Unreleased)

set -euo pipefail

DRY=0
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '6,20p' "$0" | sed 's/^# \?//'; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *)  [ -z "$VERSION" ] || { echo "extra arg: $1" >&2; exit 2; }
        VERSION="$1"; shift ;;
  esac
done

[ -z "$VERSION" ] && { echo "usage: $0 [--dry-run] <version>" >&2; exit 2; }

# SemVer-ish validation: X.Y.Z with optional -rc.N / -alpha.N / -beta.N suffix.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(rc|alpha|beta)\.[0-9]+)?$ ]]; then
  echo "version '$VERSION' must match X.Y.Z[-{rc|alpha|beta}.N]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Sanity checks
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { echo "must release from main (on '$BRANCH')" >&2; exit 1; }

git diff-index --quiet HEAD -- || { echo "working tree is dirty; commit or stash first" >&2; exit 1; }
[ -z "$(git ls-files --others --exclude-standard)" ] || { echo "untracked files present; clean first" >&2; exit 1; }

TAG="v$VERSION"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "tag $TAG already exists locally" >&2; exit 1
fi
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  echo "tag $TAG already exists on origin" >&2; exit 1
fi

grep -q '^## \[Unreleased\]' CHANGELOG.md || {
  echo "CHANGELOG.md has no '## [Unreleased]' section to convert" >&2; exit 1;
}

TODAY="$(date +%Y-%m-%d)"

# Compose the new CHANGELOG: fresh [Unreleased], then the dated section.
TMP="$(mktemp)"
awk -v v="$VERSION" -v d="$TODAY" '
  /^## \[Unreleased\]/ && !seen {
    seen=1
    print "## [Unreleased]"
    print ""
    print "## [" v "] - " d
    next
  }
  { print }
' CHANGELOG.md > "$TMP"

if [ "$DRY" = 1 ]; then
  echo "=== would write VERSION ==="
  echo "$VERSION"
  echo "=== would update CHANGELOG.md (diff vs current) ==="
  diff -u CHANGELOG.md "$TMP" || true
  echo "=== would commit, tag $TAG, push to origin ==="
  rm "$TMP"
  exit 0
fi

mv "$TMP" CHANGELOG.md
echo "$VERSION" > VERSION

git add VERSION CHANGELOG.md
git commit -m "release: $TAG"
git tag -a "$TAG" -m "Release $TAG"

echo ""
echo "Local release ready. Pushing main + $TAG to origin…"
git push origin main "$TAG"

cat <<EOF

✓ Pushed $TAG.

GitHub Actions will now:
  - Build linux/amd64 + linux/arm64 images for receiver, api, ui
  - Push to ghcr.io/photon48/agentobserve-{receiver,api,ui}:$VERSION
  - Generate manifest.json + extract CHANGELOG section as release notes
  - Create the GitHub Release with manifest.json attached

Watch progress:  gh run watch
Release page:    https://github.com/Photon48/agentObserve/releases/tag/$TAG
EOF
