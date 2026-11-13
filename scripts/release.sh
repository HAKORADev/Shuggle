#!/usr/bin/env bash
# Shuggle — cut a private release.
#
# GitHub Actions is disabled on this account, so the artifacts are built here
# and published as a release on the PRIVATE commit-sandbox repo
# (shuggle-commits-otg). The public Shuggle repo stays clean until the
# project is ready.
#
#   GITHUB_TOKEN=... scripts/release.sh [tag]
#
# Needs: bun, upx (optional), python3 + pefile (optional), curl, gh or the API.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  echo "set GITHUB_TOKEN (a PAT with repo scope)"; exit 1
fi
REPO="${SHUGGLE_RELEASE_REPO:-HAKORADev/shuggle-commits-otg}"
TAG="${1:-v0.5.0-alpha.$(date -u +%Y%m%d)}"
API="https://api.github.com/repos/$REPO"

echo "• building"
./scripts/build-release.sh

echo "• packing"
cd "$ROOT/dist"
rm -f ./*.zip
for d in Shuggle-linux-x64 Shuggle-windows-x64; do
  [ -d "$d" ] || continue
  # the split parts are uploaded on their own — no need inside the zip
  ( cd "$d" && zip -qr "../$d.zip" . -x "*.part*" )
done
cd "$ROOT"
ls -la dist/*.zip

echo "• creating the release $TAG on $REPO"

# The GitHub API is not always in the mood; retry instead of failing a build.
api_get() {
  local url="$1" out="" i
  for i in 1 2 3 4 5; do
    out="$(curl -s --max-time 60 -H "Authorization: token $TOKEN" "$url")"
    case "$out" in
      *"Bad credentials"*|""message":"Internal"*|""message":"Unavailable"*) sleep $((i * 2));;
      *) echo "$out"; return 0;;
    esac
  done
  echo "$out"
}

api_post() {
  local url="$1" body="$2" out="" i
  for i in 1 2 3 4 5; do
    out="$(curl -s --max-time 120 -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" "$url" -d "$body")"
    case "$out" in
      *"Bad credentials"*|""message":"Internal"*|""message":"Unavailable"*) sleep $((i * 2));;
      *) echo "$out"; return 0;;
    esac
  done
  echo "$out"
}

existing="$(api_get "$API/releases/tags/$TAG")"
release_id="$(echo "$existing" | python3 -c "
import sys, json
try:
    j = json.load(sys.stdin)
except Exception:
    print('')
    raise SystemExit(0)
print(j.get('id', '') if isinstance(j, dict) else '')
")"
if [ -n "$release_id" ]; then
  echo "  release exists ($release_id) — replacing the assets"
  for aid in $(echo "$existing" | python3 -c "
import sys, json
try:
    j = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
print(' '.join(str(a['id']) for a in (j.get('assets') or [])))
"); do
    curl -s -X DELETE -H "Authorization: token $TOKEN" "$API/releases/assets/$aid" >/dev/null
  done
else
  release_id="$(api_post "$API/releases" "$(python3 - "$TAG" <<'PY'
import json, sys
tag = sys.argv[1]
print(json.dumps({
    "tag_name": tag,
    "name": f"Shuggle {tag} (private build)",
    "body": "Shuffle around freely.\n\n"
            "This is a private pre-release build of Shuggle — the public repo is "
            "still in development. Unpack the zip, run `shuggle` (Linux) or "
            "`Shuggle.exe` (Windows). The model runs on your own Kaggle GPU "
            "hours; nothing is local compute.",
    "draft": False,
    "prerelease": True,
}))
PY
)" | python3 -c "
import sys, json
try:
    j = json.load(sys.stdin)
except Exception as e:
    print(''); raise SystemExit(0)
print(j.get('id', '') if isinstance(j, dict) else '')
")"
  if [ -z "$release_id" ]; then
    echo "  could not create the release — the GitHub API did not answer"
    exit 1
  fi
  echo "  created release $release_id"
fi

echo "• packing the launchers (for the parts-only download)"
( cd dist/Shuggle-windows-x64 2>/dev/null && zip -qr ../Shuggle-launchers.zip . -x "*.part*" "*.exe" ) || true
( cd dist/Shuggle-linux-x64 2>/dev/null && zip -qr ../Shuggle-launchers-linux.zip . -x "*.part*" "shuggle" ) || true

echo "• uploading"
for f in dist/*.zip dist/SHA256SUMS.txt dist/*/*.part*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  echo "  $name"
  curl -s -X POST \
    -H "Authorization: token $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$f" \
    "https://uploads.github.com/repos/$REPO/releases/$release_id/assets?name=$name" \
    | python3 -c "import sys,json;j=json.load(sys.stdin);print('    →',j.get('browser_download_url') or j)" 2>/dev/null || true
done

echo
echo "Release ready: https://github.com/$REPO/releases/tag/$TAG"
