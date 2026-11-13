#!/usr/bin/env bash
# Shuggle — build the release artifacts locally.
#
# GitHub Actions is disabled on this account, so the build happens here:
#   scripts/build-release.sh
#
# Produces:
#   dist/Shuggle-linux-x64/shuggle          (+ .sh launchers)
#   dist/Shuggle-windows-x64/Shuggle.exe    (+ .bat launchers)
#
# The Windows binary is cross-compiled by Bun (no Windows machine needed) and
# both are UPX-compressed — the Bun runtime is ~109 MB, UPX brings it to ~35.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

VERSION="$(grep -o '"version": *"[^"]*"' package.json | head -1 | cut -d'"' -f4)"
DIST="$ROOT/dist"
echo "Shuggle $VERSION — building in $ROOT"

command -v bun >/dev/null || { echo "bun is required (npm i -g bun)"; exit 1; }
command -v upx >/dev/null || echo "note: upx not found — shipping uncompressed"

# Build in a scratch directory: this workspace lives on an NFS mount, where a
# compiler that writes-then-renames leaves busy ".nfs*" files behind that
# cannot be removed and break the next build.
BUILD="$(mktemp -d /tmp/shuggle-build-XXXXXX)"
trap 'rm -rf "$BUILD" 2>/dev/null || true' EXIT
mkdir -p "$BUILD/Shuggle-linux-x64" "$BUILD/Shuggle-windows-x64"
rm -rf "$DIST" 2>/dev/null || true
mkdir -p "$DIST"

# ---------------------------------------------------------------- UI bundle --
echo "• bundling the UI"
bun run build:ui

# ------------------------------------------------------------------- linux --
echo "• compiling the linux binary"
bun build src/shuggle.ts --compile --minify --outfile="$BUILD/Shuggle-linux-x64/shuggle"
cp launcher/shuggle.sh launcher/shuggle-lan.sh "$BUILD/Shuggle-linux-x64/"
chmod +x "$BUILD/Shuggle-linux-x64/shuggle" "$BUILD/Shuggle-linux-x64"/*.sh

# ----------------------------------------------------------------- windows --
echo "• cross-compiling the windows binary"
bun build src/shuggle.ts --compile --minify \
  --target=bun-windows-x64 \
  --outfile="$BUILD/Shuggle-windows-x64/Shuggle.exe"

# Bun can only embed an .ico when it compiles ON Windows, so the icon and the
# version info are injected into the PE here (scripts/windows_resources.py).
# The subsystem stays CONSOLE on purpose: the CLI verbs must print to the
# terminal, and the window mode hides the console at runtime instead.
if python3 -c "import pefile" 2>/dev/null; then
  python3 scripts/windows_resources.py "$BUILD/Shuggle-windows-x64/Shuggle.exe" assets/shuggle.ico
else
  echo "  note: pefile is missing — the exe ships without an icon (pip install pefile)"
fi
cp "launcher/Shuggle.bat" "launcher/Shuggle CLI.bat" "launcher/Shuggle Ask.bat" "launcher/Shuggle LAN.bat" \
  "$BUILD/Shuggle-windows-x64/"

# --------------------------------------------------------------------- upx --
# UPX does NOT work on a Bun single-file executable: the packer rewrites the
# embedded payload and the binary dies with
#   SyntaxError: Invalid character: '\0'
# So compression is opt-in, and even then the result is TESTED before it is
# shipped. The zip in the release already halves the download (~105 MB → ~45 MB).
# Only the linux binary is ever packed: a windows exe cannot be run here to
# prove it survived, and an unverified pack is worse than a big download.
compress_linux() {
  local bin="$1"
  command -v upx >/dev/null || return 0
  [ "${SHUGGLE_UPX:-0}" = "1" ] || return 0
  local tmp="${bin}.packed"
  cp "$bin" "$tmp"
  if upx -q --best "$tmp" >/dev/null 2>&1 && "$tmp" version >/dev/null 2>&1; then
    mv "$tmp" "$bin"
    echo "  compressed $(basename "$bin")"
  else
    echo "  note: upx broke $(basename "$bin") — shipping it uncompressed"
    rm -f "$tmp"
  fi
}
if [ "${SHUGGLE_UPX:-0}" = "1" ]; then echo "• compressing (upx, verified)"; fi
compress_linux "$BUILD/Shuggle-linux-x64/shuggle"

# ------------------------------------------------------------- smoke tests --
echo "• smoke testing the linux binary"
"$BUILD/Shuggle-linux-x64/shuggle" version
"$BUILD/Shuggle-linux-x64/shuggle" help | head -3

PORT=8788
"$BUILD/Shuggle-linux-x64/shuggle" --data=/tmp/shuggle-release-smoke serve --port=$PORT >/tmp/shuggle-release-smoke.log 2>&1 &
SRV=$!
sleep 3
fail=0
check() { if [ "$1" -gt "$2" ]; then echo "  ok   $3 ($1 bytes)"; else echo "  FAIL $3 ($1 bytes)"; fail=1; fi; }
check "$(curl -s http://127.0.0.1:$PORT/ | wc -c)" 1000 "index.html is not empty"
check "$(curl -s http://127.0.0.1:$PORT/app.js | wc -c)" 1000 "app.js is not empty"
check "$(curl -s http://127.0.0.1:$PORT/style.css | wc -c)" 500 "style.css is not empty"
check "$(curl -s http://127.0.0.1:$PORT/favicon.svg | wc -c)" 100 "favicon.svg"
curl -sf -o /dev/null http://127.0.0.1:$PORT/api/health && echo "  ok   api/health" || { echo "  FAIL api/health"; fail=1; }
kill $SRV 2>/dev/null || true
[ $fail -eq 0 ] || { echo "smoke test failed"; exit 1; }

# ------------------------------------------------------------------ parts ---
# Some connections die on a 100 MB download. The binaries are also offered in
# ~25 MB parts; the launchers join them on the first run.
echo "• splitting the binaries into parts"
split_parts() {
  local bin="$1" prefix="$2" size="${3:-25}"
  [ -f "$bin" ] || return 0
  split -b "${size}M" -d -a 2 "$bin" "${prefix}.part"
}
split_parts "$BUILD/Shuggle-linux-x64/shuggle" "$BUILD/Shuggle-linux-x64/shuggle"
split_parts "$BUILD/Shuggle-windows-x64/Shuggle.exe" "$BUILD/Shuggle-windows-x64/Shuggle.exe"

# ------------------------------------------------------------------ stage ---
mkdir -p "$DIST"
rm -rf "$DIST/Shuggle-linux-x64" "$DIST/Shuggle-windows-x64" 2>/dev/null || true
cp -a "$BUILD/Shuggle-linux-x64" "$BUILD/Shuggle-windows-x64" "$DIST/"

# ----------------------------------------------------------------- sha256 ---
echo "• checksums"
# -print0/-0: the launcher names have spaces in them
( cd "$DIST" && find . -type f ! -name SHA256SUMS.txt -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt )
cat "$DIST/SHA256SUMS.txt"

echo
echo "Done. Artifacts:"
du -h "$DIST"/*/ | sort -h
