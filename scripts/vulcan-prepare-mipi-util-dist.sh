#!/usr/bin/env bash
# Stage the sima-mipi-util Vulcan package inputs into a dist directory:
#   - the built .deb (must already be present in dist_dir)
#   - the install script, copied in as install_sima_mipi_util.py
#
# Prints the package version (derived from the .deb filename) on stdout so CI
# can pass it to `sima-cli packages build --version`.
#
# Usage: scripts/vulcan-prepare-mipi-util-dist.sh [dist_dir]
set -euo pipefail

dist_dir="${1:-dist}"
installer_src="scripts/install-vulcan-sima-mipi-util.py"
installer_dst="${dist_dir}/install_sima_mipi_util.py"

if [[ ! -d "${dist_dir}" ]]; then
  echo "ERROR: dist directory does not exist: ${dist_dir}" >&2
  exit 1
fi
if [[ ! -f "${installer_src}" ]]; then
  echo "ERROR: installer script not found: ${installer_src}" >&2
  exit 1
fi

shopt -s nullglob
debs=( "${dist_dir}"/sima-mipi-util_*_arm64.deb )
shopt -u nullglob
if [[ "${#debs[@]}" -eq 0 ]]; then
  echo "ERROR: no sima-mipi-util_*_arm64.deb found in ${dist_dir}" >&2
  exit 1
fi
if [[ "${#debs[@]}" -ne 1 ]]; then
  echo "ERROR: expected exactly one .deb in ${dist_dir}, found ${#debs[@]}:" >&2
  printf '  %s\n' "${debs[@]}" >&2
  exit 1
fi

cp "${installer_src}" "${installer_dst}"
chmod +x "${installer_dst}"

# Version from filename: sima-mipi-util_<version>_arm64.deb
base="$(basename "${debs[0]}")"
version="${base#sima-mipi-util_}"
version="${version%_arm64.deb}"

echo "Prepared ${installer_dst}" >&2
echo "Package deb: ${debs[0]}" >&2
echo "${version}"
