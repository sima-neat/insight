#!/usr/bin/env bash
set -euo pipefail

dist_dir="${1:-dist}"
installer_src="scripts/install-vulcan-neat-insight.py"
installer_dst="${dist_dir}/install_neat_insight.py"
manifest_dst="${dist_dir}/neat_insight_vulcan_manifest.json"

if [[ ! -d "${dist_dir}" ]]; then
  echo "ERROR: dist directory does not exist: ${dist_dir}" >&2
  exit 1
fi

if [[ ! -f "${installer_src}" ]]; then
  echo "ERROR: installer script not found: ${installer_src}" >&2
  exit 1
fi

python3 - "${dist_dir}" "${manifest_dst}" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse

dist = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
wheels = sorted(dist.glob("neat_insight-*.whl"))
if not wheels:
    raise SystemExit(f"No neat_insight wheels found in {dist}")

versions = set()
wheel_entries = []
for wheel in wheels:
    match = re.match(r"^neat_insight-(?P<version>.+?)-py3-none-.+\.whl$", wheel.name)
    if not match:
        raise SystemExit(f"Unexpected neat_insight wheel filename: {wheel.name}")
    versions.add(match.group("version"))
    hasher = hashlib.sha256()
    with wheel.open("rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
            hasher.update(chunk)
    wheel_entries.append({
        "resource": wheel.name,
        "sha256": hasher.hexdigest(),
        "size": wheel.stat().st_size,
    })

if len(versions) != 1:
    raise SystemExit(f"Expected all neat_insight wheels to share one version, got: {sorted(versions)}")

version = next(iter(versions))
ref_name = os.environ.get("GITHUB_HEAD_REF") or os.environ.get("GITHUB_REF_NAME", "")
sha = os.environ.get("GITHUB_SHA", "")
short_sha = sha[:12]
artifact_base_url = os.environ.get("VULCAN_ARTIFACT_BASE_URL", "").rstrip("/")
if artifact_base_url and ref_name and short_sha:
    ref_key = urllib.parse.quote(ref_name, safe="")
    ref_url_key = urllib.parse.quote(ref_key, safe="")
    artifact_base_url = f"{artifact_base_url}/insight/{ref_url_key}/{short_sha}"
else:
    ref_key = ""
    ref_url_key = ""

manifest = {
    "schema": "sima.neat.insight.vulcan-installer.v1",
    "name": "gh:sima-neat/insight",
    "version": version,
    "ref": ref_name,
    "ref_key": ref_key,
    "ref_url_key": ref_url_key,
    "commit": sha,
    "commit_folder": short_sha,
    "artifact_base_url": artifact_base_url,
    "wheels": wheel_entries,
}
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${manifest_dst}")"

cp "${installer_src}" "${installer_dst}"
chmod +x "${installer_dst}"
echo "Prepared ${installer_dst}" >&2
echo "Prepared ${manifest_dst}" >&2
echo "${version}"
