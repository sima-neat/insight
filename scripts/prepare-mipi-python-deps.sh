#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
requirements="${repo_root}/mipi-util/requirements-runtime.txt"
vendor_root="${repo_root}/mipi-util/vendor"
wheel_dir="${vendor_root}/wheels"

python_version="${MIPI_PYTHON_VERSION:-311}"
python_abi="${MIPI_PYTHON_ABI:-cp${python_version}}"
wheel_platform="${MIPI_WHEEL_PLATFORM:-manylinux2014_aarch64}"

if [[ ! -f "${requirements}" ]]; then
  echo "ERROR: runtime requirements not found: ${requirements}" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
tmp_wheels="${tmp_dir}/wheels"
mkdir -p "${tmp_wheels}"

python3 -m pip download \
  --dest "${tmp_wheels}" \
  --only-binary=:all: \
  --platform "${wheel_platform}" \
  --implementation cp \
  --python-version "${python_version}" \
  --abi "${python_abi}" \
  --requirement "${requirements}"

expected_count="$(awk 'NF && $1 !~ /^#/ {count++} END {print count + 0}' "${requirements}")"
actual_count="$(find "${tmp_wheels}" -maxdepth 1 -type f -name '*.whl' | wc -l)"
if [[ "${actual_count}" -ne "${expected_count}" ]]; then
  echo "ERROR: expected ${expected_count} wheels, downloaded ${actual_count}" >&2
  exit 1
fi

(
  cd "${tmp_wheels}"
  # Record the CPython the wheels target so postinst can verify the device
  # interpreter matches before an offline install that can't fall back.
  printf '%s\n' "${python_version//./}" > PYTHON_TAG
  sha256sum ./*.whl PYTHON_TAG > SHA256SUMS
)

mkdir -p "${vendor_root}"
if [[ -e "${wheel_dir}" ]]; then
  rm -rf -- "${wheel_dir}"
fi
mv "${tmp_wheels}" "${wheel_dir}"

echo "Prepared ${actual_count} wheels for CPython ${python_version}" \
     "(${python_abi}, ${wheel_platform}) in ${wheel_dir}"
