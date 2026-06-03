#!/usr/bin/env bash
set -euo pipefail

DIST_DIR="${1:-dist}"
EXPECTED_WHEELS="${EXPECTED_WHEELS:-4}"
INSTALLER_SOURCE="${INSTALLER_SOURCE:-scripts/vulcan-install-neat-insight.py}"
INSTALLER_NAME="${INSTALLER_NAME:-install_neat_insight.py}"

dist_path="${DIST_DIR%/}"
if [[ ! -d "$dist_path" ]]; then
  echo "dist directory not found: $dist_path" >&2
  exit 1
fi

wheels=()
while IFS= read -r wheel; do
  wheels+=("$wheel")
done < <(find "$dist_path" -maxdepth 1 -type f -name 'neat_insight-*.whl' -print | sort)

if [[ "${#wheels[@]}" -ne "$EXPECTED_WHEELS" ]]; then
  echo "Expected ${EXPECTED_WHEELS} neat-insight wheels, found ${#wheels[@]}:" >&2
  printf '  %s\n' "${wheels[@]}" >&2
  exit 1
fi

cp "$INSTALLER_SOURCE" "$dist_path/$INSTALLER_NAME"
chmod +x "$dist_path/$INSTALLER_NAME"

python3 - "$dist_path" <<'PY'
from pathlib import Path
import sys

wheels = sorted(Path(sys.argv[1]).glob("neat_insight-*.whl"))
versions = {wheel.name.split("-")[1] for wheel in wheels}
if len(versions) != 1:
    raise SystemExit(f"Expected all wheels to share one version, found {sorted(versions)}")
print(sorted(versions)[0])
PY
