#!/usr/bin/env bash
# Build precompiled gh-drop binaries for every OS/arch gh supports.
# Called by cli/gh-extension-precompile@v2 at release time, with the tag
# name as $1.
#
# Produces files in ./dist/ named: gh-drop_<tag>_<os>-<arch>[.exe]
# That naming is how `gh extension install` locates the right asset.
#
# We use `bun build --compile --target=...` to produce a self-contained
# single-file executable — no runtime Bun required on the user's machine.
#
# See: https://bun.sh/docs/bundler/executables#cross-compile-to-other-platforms

set -euo pipefail

TAG="${1:-dev}"
ENTRY="src/cli.ts"
OUT_DIR="dist"
NAME="gh-drop"

mkdir -p "$OUT_DIR"

# Map of gh-extension {os}-{arch} → bun --target
# bun supports linux/darwin/windows × x64/arm64; no 32-bit, no freebsd.
# If/when users request more platforms we'll fall back to the bash shim.
TARGETS=(
  "darwin-amd64:bun-darwin-x64"
  "darwin-arm64:bun-darwin-arm64"
  "linux-amd64:bun-linux-x64"
  "linux-arm64:bun-linux-arm64"
  "windows-amd64:bun-windows-x64"
)

for entry in "${TARGETS[@]}"; do
  gh_triple="${entry%%:*}"
  bun_target="${entry##*:}"

  ext=""
  [[ "$gh_triple" == windows-* ]] && ext=".exe"

  out="$OUT_DIR/${NAME}_${TAG}_${gh_triple}${ext}"
  echo "→ building $out ($bun_target)"

  bun build "$ENTRY" \
    --compile \
    --minify \
    --target="$bun_target" \
    --outfile="$out"
done

# gh-extension-precompile uploads every file in dist/ as a release asset.
# Drop anything that isn't an executable to keep the release page tidy.
find "$OUT_DIR" -maxdepth 1 -type f ! -name "${NAME}_*" -delete

echo "✓ wrote $(ls -1 "$OUT_DIR" | wc -l) binaries to $OUT_DIR/"
ls -lh "$OUT_DIR"
