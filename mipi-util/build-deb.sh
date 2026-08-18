#!/usr/bin/env bash
# Build the sima-mipi-util Debian package from source/ into a clean tree.
#
# Reproducible and CI-callable: builds from an empty staging dir so stale files
# can't leak in, and takes the version from DEBIAN/control unless overridden
# (CI passes the branch/tag-derived version so the artifact isn't pinned to a
# hardcoded 1.0.0).
#
# Usage:
#   ./build-deb.sh [output_dir]
#   VERSION=1.2.3 ./build-deb.sh dist
#
# Output: <output_dir>/sima-mipi-util_<version>_arm64.deb  (prints its path on stdout)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

OUT_DIR="${1:-dist}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# mktemp -d is 0700; the package root must be world-readable/traversable (0755)
# or lintian flags non-standard-dir-perm on `./`.
chmod 0755 "$STAGE"

# Version: explicit env override wins, else read DEBIAN/control.
VERSION="${VERSION:-$(awk -F': ' '/^Version:/{print $2; exit}' DEBIAN/control)}"
if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not determine version (set VERSION= or add Version: to DEBIAN/control)" >&2
  exit 1
fi

RUNTIME_REQUIREMENTS="requirements-runtime.txt"
WHEEL_DIR="vendor/wheels"
if [[ ! -f "$RUNTIME_REQUIREMENTS" || ! -f "$WHEEL_DIR/SHA256SUMS" || ! -f "$WHEEL_DIR/PYTHON_TAG" ]]; then
  echo "ERROR: bundled Python dependencies are missing; run" >&2
  echo "  ../scripts/prepare-mipi-python-deps.sh" >&2
  exit 1
fi

wheels=("$WHEEL_DIR"/*.whl)
if [[ ! -e "${wheels[0]}" ]]; then
  echo "ERROR: no bundled Python wheels found in $WHEEL_DIR" >&2
  exit 1
fi

(cd "$WHEEL_DIR" && sha256sum -c SHA256SUMS >/dev/null)

# Lay out the filesystem the package installs.
install -d "$STAGE/usr/share/sima-mipi-util/wheels" \
           "$STAGE/usr/bin" \
           "$STAGE/lib/systemd/system" \
           "$STAGE/etc/logrotate.d" \
           "$STAGE/DEBIAN"

install -m 0644 source/camera_api.py source/camera_ui.html "$STAGE/usr/share/sima-mipi-util/"
install -m 0644 "$RUNTIME_REQUIREMENTS" "$STAGE/usr/share/sima-mipi-util/"
install -m 0644 "$WHEEL_DIR/SHA256SUMS" "$WHEEL_DIR/PYTHON_TAG" "${wheels[@]}" "$STAGE/usr/share/sima-mipi-util/wheels/"
install -m 0755 source/sima-mipi-util                       "$STAGE/usr/bin/sima-mipi-util"
install -m 0644 source/sima-mipi-util.service              "$STAGE/lib/systemd/system/sima-mipi-util.service"
install -m 0644 source/sima-mipi-util.logrotate           "$STAGE/etc/logrotate.d/sima-mipi-util"

# Control files. Stamp the resolved version into the copied control so the
# metadata inside the .deb matches the output filename.
cp DEBIAN/control DEBIAN/postinst DEBIAN/prerm DEBIAN/postrm "$STAGE/DEBIAN/"
sed -i "s/^Version:.*/Version: ${VERSION}/" "$STAGE/DEBIAN/control"
chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm" "$STAGE/DEBIAN/postrm"

mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/sima-mipi-util_${VERSION}_arm64.deb"

# fakeroot so files inside the archive are owned by root:root even when built
# by an unprivileged CI user.
if command -v fakeroot >/dev/null 2>&1; then
  fakeroot dpkg-deb --build "$STAGE" "$DEB" >&2
else
  dpkg-deb --build "$STAGE" "$DEB" >&2
fi

echo "$DEB"
