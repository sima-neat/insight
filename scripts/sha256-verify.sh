#!/bin/bash
# Check that a file's SHA-256 is the one expected (64 lowercase hex digits); say both when not.
# Usage: scripts/sha256-verify.sh <file> <sha256>
# build.sh and CI run it on each MediaMTX archive they download, against build.sh's pins.
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 <file> <sha256>" >&2; exit 2; }
FILE=$1 EXPECTED=$2
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] || { echo "not a SHA-256: '$EXPECTED'" >&2; exit 2; }
[[ -f "$FILE" ]] || { echo "no such file: $FILE" >&2; exit 1; }
if command -v sha256sum >/dev/null; then
  ACTUAL=$(sha256sum "$FILE" | cut -d' ' -f1)
else
  ACTUAL=$(shasum -a 256 "$FILE" | cut -d' ' -f1) # macOS
fi
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "SHA-256 mismatch for $FILE: expected $EXPECTED, got $ACTUAL" >&2
  exit 1
fi
