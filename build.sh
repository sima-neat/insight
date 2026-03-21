#!/bin/bash
set -e

# ==== Configuration ====
MTX_VERSION="1.12.1"
BUILD_DIR="build"
GO_TEMP_DIR="$BUILD_DIR/go_viewer"
MTX_BASE_URL="https://github.com/bluenviron/mediamtx/releases/download/v${MTX_VERSION}"
VF_OUTPUT="$BUILD_DIR/vf"
MTX_OUTPUT="$BUILD_DIR/mediamtx_bin"
INSIGHT_BIN="neat_insight/bin"
DIST_DIR="dist"

INSTALL_WHEEL=0
SKIP_FRONTEND=0
WHEEL_PLAT_NAME=""
PACKAGE_VERSION=""
TARGET_PLATFORM="host"

usage() {
    cat <<EOF
Usage: ./build.sh [options]

Options:
  --release        Deprecated (no Docker installer artifacts are produced)
  --install        Install built neat-insight wheel into active virtualenv
  --skip-frontend  Skip npm frontend build step
  --target-platform  Build target platform:
                     host (default), all, linux-aarch64, linux-amd64, macos-arm64, windows-amd64
  -h, --help       Show this help
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --release)
            echo "⚠️ --release is deprecated and has no additional effect."
            ;;
        --install)
            INSTALL_WHEEL=1
            ;;
        --skip-frontend)
            SKIP_FRONTEND=1
            ;;
        --target-platform)
            TARGET_PLATFORM="${2:-}"
            if [[ -z "$TARGET_PLATFORM" ]]; then
                echo "❌ --target-platform requires a value."
                usage
                exit 1
            fi
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "❌ Unknown option: $1"
            usage
            exit 1
            ;;
    esac
    shift
done

# ==== Helpers ====
sanitize_pep440_local_part() {
    local value="$1"
    value=$(echo "$value" | tr '[:upper:]' '[:lower:]')
    value=$(echo "$value" | sed -E 's/[^a-z0-9]+/./g; s/^\.//; s/\.$//; s/\.\.+/./g')
    if [[ -z "$value" ]]; then
        value="unknown"
    fi
    echo "$value"
}


resolve_package_version() {
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        PACKAGE_VERSION="0.0.0+unknown"
        echo "📦 PACKAGE_VERSION set to $PACKAGE_VERSION (no git repo)"
        return
    fi

    local tag
    while IFS= read -r tag; do
        if [[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
            PACKAGE_VERSION="${BASH_REMATCH[1]}"
            echo "📦 PACKAGE_VERSION set to $PACKAGE_VERSION (from tag $tag)"
            return
        fi
        if [[ "$tag" =~ ^([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
            PACKAGE_VERSION="${BASH_REMATCH[1]}"
            echo "📦 PACKAGE_VERSION set to $PACKAGE_VERSION (from tag $tag)"
            return
        fi
    done < <(git tag --points-at HEAD)

    local branch short_hash local_branch
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    short_hash=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    local_branch=$(sanitize_pep440_local_part "$branch")
    PACKAGE_VERSION="0.0.0+${local_branch}.${short_hash}"
    echo "📦 PACKAGE_VERSION set to $PACKAGE_VERSION (from branch/hash)"
}


build_frontend() {
    if [[ "$SKIP_FRONTEND" == "1" ]]; then
        echo "⏭️ Skipping frontend build (--skip-frontend)"
        return
    fi

    if [[ ! -f frontend/package.json ]]; then
        echo "❌ frontend/package.json not found."
        exit 1
    fi
    if ! command -v npm >/dev/null 2>&1; then
        echo "❌ npm not found. Install Node.js/npm or use --skip-frontend."
        exit 1
    fi

    echo "🧱 Building frontend..."
    pushd frontend > /dev/null
    if [[ -f package-lock.json ]]; then
        npm ci
    else
        npm install
    fi
    npm run build
    npm run build:viewer
    popd > /dev/null
}


install_wheel_into_venv() {
    if [[ "$INSTALL_WHEEL" != "1" ]]; then
        return
    fi

    if [[ -z "${VIRTUAL_ENV:-}" ]]; then
        echo "❌ --install requested but no active virtualenv detected."
        echo "   Activate your venv first (e.g. source .venv/bin/activate)."
        exit 1
    fi

    local wheel
    wheel=$(ls -t "$DIST_DIR"/neat_insight-*.whl 2>/dev/null | head -n 1 || true)
    if [[ -z "$wheel" ]]; then
        echo "❌ No neat-insight wheel found in $DIST_DIR/."
        exit 1
    fi

    echo "📥 Installing wheel into virtualenv: $VIRTUAL_ENV"
    python3 -m pip install --force-reinstall "$wheel"
}


ensure_go() {
    REQUIRED_VERSION="1.24.5"
    GO_OK=0
    if command -v go >/dev/null 2>&1; then
        GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
        GO_MAJOR=$(echo "$GO_VERSION" | cut -d. -f1)
        GO_MINOR=$(echo "$GO_VERSION" | cut -d. -f2)

        if [[ "$GO_MAJOR" -gt 1 || ( "$GO_MAJOR" -eq 1 && "$GO_MINOR" -ge 24 ) ]]; then
            echo "✅ Go version $GO_VERSION is installed."
            GO_OK=1
        else
            echo "⚠️ Found Go $GO_VERSION, but 1.24 or newer is required."
        fi
    else
        echo "⚠️ Go is not installed."
    fi

    if [[ $GO_OK -eq 0 ]]; then
        read -p "👉 Do you want to install Go $REQUIRED_VERSION now? [y/N]: " INSTALL_GO
        if [[ "$INSTALL_GO" =~ ^[Yy]$ ]]; then
            install_go "$REQUIRED_VERSION"
        else
            echo "❌ Cannot proceed without Go 1.24+. Exiting."
            exit 1
        fi
    fi
}

install_go() {
    VERSION=$1
    echo "📦 Installing Go $VERSION..."
    OS=$(uname -s)
    ARCH=$(uname -m)

    if [[ "$OS" == "Linux" ]]; then
        if [[ "$ARCH" == "x86_64" ]]; then
            GO_TAR="go${VERSION}.linux-amd64.tar.gz"
        elif [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
            GO_TAR="go${VERSION}.linux-arm64.tar.gz"
        else
            echo "❌ Unsupported Linux architecture: $ARCH"
            exit 1
        fi
    else
        echo "❌  Auto-install only supported on Linux for now. Please install Go manually."
        exit 1
    fi


    curl -LO "https://go.dev/dl/${GO_TAR}"
    mkdir -p ~/.local
    tar -C ~/.local -xzf "$GO_TAR"
    rm "$GO_TAR"
    export PATH="$HOME/.local/go/bin:$PATH"

    echo "✅ Go installed to ~/.local/go"
    echo "👉 Please add the following to your shell profile:"
    echo 'export PATH="$HOME/.local/go/bin:$PATH"'
}

build_python_package() {
    echo "🧪 Developer build mode..."
    export PACKAGE_VERSION

    if ! python3 -m pip show wheel > /dev/null 2>&1; then
        echo "📦 Installing Python wheel module..."
        python3 -m pip install --upgrade wheel
    fi

    if [[ -z "$WHEEL_PLAT_NAME" ]]; then
        echo "❌ Wheel platform tag is not set."
        exit 1
    fi

    echo "🐍 Building platform wheel: $WHEEL_PLAT_NAME"
    PACKAGE_VERSION="$PACKAGE_VERSION" \
    python3 -m pip wheel \
        --no-deps \
        --no-build-isolation \
        --wheel-dir "$DIST_DIR" \
        --config-settings=--build-option=--plat-name="$WHEEL_PLAT_NAME" \
        .
}

# ==== Start Build ====
export PATH="$HOME/.local/go/bin:$PATH"
resolve_package_version
build_frontend
ensure_go

if [[ "$TARGET_PLATFORM" == "all" && "$INSTALL_WHEEL" == "1" ]]; then
    echo "❌ --install cannot be used with --target-platform all."
    echo "   Build all wheels first, then install a specific one manually."
    exit 1
fi

mkdir -p "$BUILD_DIR"
rm -rf "$GO_TEMP_DIR"
mkdir -p "$GO_TEMP_DIR"

# ==== Prepare Go build temp module ====
cp webrtc/viewer.go "$GO_TEMP_DIR/"
pushd "$GO_TEMP_DIR" > /dev/null
go mod init viewer
go mod tidy

# ==== Detect Platform and Build Go App ====
OS=$(uname -s)
ARCH=$(uname -m)
TARGET=""
GOOS=""
GOARCH=""
PLATFORM=""
TARGETS_TO_BUILD=()

resolve_target_from_host() {
    if is_palette; then
        echo "linux-aarch64"
        return
    fi

    if [[ "$OS" == "Linux" && "$ARCH" == "aarch64" ]]; then
        echo "linux-aarch64"
    elif [[ "$OS" == "Linux" && "$ARCH" == "x86_64" ]]; then
        echo "linux-amd64"
    elif [[ "$OS" == "Darwin" ]]; then
        echo "macos-arm64"
    elif [[ "$OS" == "Windows_NT" || "$OS" == MINGW* || "$OS" == MSYS* || "$OS" == CYGWIN* ]]; then
        echo "windows-amd64"
    else
        echo "unsupported"
    fi
}

if [[ "$TARGET_PLATFORM" == "host" ]]; then
    TARGET_PLATFORM="$(resolve_target_from_host)"
fi

case "$TARGET_PLATFORM" in
    all)
    TARGETS_TO_BUILD=("linux-aarch64" "linux-amd64" "macos-arm64" "windows-amd64")
    ;;
    linux-aarch64|linux-amd64|macos-arm64|windows-amd64)
    TARGETS_TO_BUILD=("$TARGET_PLATFORM")
    ;;
    *)
    echo "❌ Unsupported target platform: $TARGET_PLATFORM"
    usage
    exit 1
    ;;
esac

popd > /dev/null

for target in "${TARGETS_TO_BUILD[@]}"; do
    VF_BIN_NAME="vf"
    MTX_BIN_NAME="mediamtx"
    MTX_ARCHIVE_EXT="tar.gz"
    case "$target" in
        linux-aarch64)
        GOOS="linux"
        GOARCH="arm64"
        PLATFORM="linux_arm64"
        TARGET="mediamtx_v${MTX_VERSION}_${PLATFORM}"
        WHEEL_PLAT_NAME="manylinux2014_aarch64"
        ;;

        linux-amd64)
        GOOS="linux"
        GOARCH="amd64"
        PLATFORM="linux_amd64"
        TARGET="mediamtx_v${MTX_VERSION}_${PLATFORM}"
        WHEEL_PLAT_NAME="manylinux2014_x86_64"
        ;;

        macos-arm64)
        GOOS="darwin"
        GOARCH="arm64"
        PLATFORM="darwin_arm64"
        TARGET="mediamtx_v${MTX_VERSION}_${PLATFORM}"
        WHEEL_PLAT_NAME="macosx_11_0_arm64"
        ;;

        windows-amd64)
        GOOS="windows"
        GOARCH="amd64"
        PLATFORM="windows_amd64"
        TARGET="mediamtx_v${MTX_VERSION}_${PLATFORM}"
        WHEEL_PLAT_NAME="win_amd64"
        VF_BIN_NAME="vf.exe"
        MTX_BIN_NAME="mediamtx.exe"
        MTX_ARCHIVE_EXT="zip"
        ;;
    esac

    echo "🛠 Building target: $target"
    pushd "$GO_TEMP_DIR" > /dev/null
    echo "🧱 Go build target GOOS=$GOOS GOARCH=$GOARCH"
    GOOS="$GOOS" GOARCH="$GOARCH" CGO_ENABLED=0 go build -o "../$VF_BIN_NAME" viewer.go
    popd > /dev/null

    # ==== Prepare neat_insight/bin ====
    echo "📂 Preparing neat_insight/bin for $target"
    rm -rf "$INSIGHT_BIN"
    mkdir -p "$INSIGHT_BIN"

    # ==== Download and Extract mediamtx ====
    MTX_ARCHIVE="${TARGET}.${MTX_ARCHIVE_EXT}"
    MTX_URL="${MTX_BASE_URL}/${MTX_ARCHIVE}"
    echo "⬇️ Downloading mediamtx: $MTX_URL"
    curl -L "$MTX_URL" -o "$BUILD_DIR/$MTX_ARCHIVE"

    echo "📦 Extracting $MTX_ARCHIVE"
    if [[ "$MTX_ARCHIVE_EXT" == "zip" ]]; then
        unzip -o "$BUILD_DIR/$MTX_ARCHIVE" -d "$BUILD_DIR" > /dev/null
    else
        tar -xzf "$BUILD_DIR/$MTX_ARCHIVE" -C "$BUILD_DIR"
    fi
    cp "$BUILD_DIR/$MTX_BIN_NAME" "$INSIGHT_BIN/$MTX_BIN_NAME"
    chmod +x "$INSIGHT_BIN/$MTX_BIN_NAME" || true
    rm "$BUILD_DIR/$MTX_ARCHIVE"

    # ==== Copy app assets ====
    cp "$BUILD_DIR/$VF_BIN_NAME" "$INSIGHT_BIN/$VF_BIN_NAME"
    chmod +x "$INSIGHT_BIN/$VF_BIN_NAME" || true
    cp -r webrtc/static "$INSIGHT_BIN/"
    cp webrtc/mediamtx.yml "$INSIGHT_BIN/"

    # Bundle built React frontend into the Python package for wheel installs.
    if [[ -d "frontend/dist" ]]; then
        echo "📦 Bundling frontend/dist into neat_insight/frontend_dist"
        rm -rf neat_insight/frontend_dist
        mkdir -p neat_insight/frontend_dist
        cp -r frontend/dist/. neat_insight/frontend_dist/
    else
        echo "⚠️ frontend/dist not found. UI will not be bundled into wheel."
    fi

    # ==== Python Packaging ====
    echo "🐍 Building Python wheel for $target ($WHEEL_PLAT_NAME)"
    build_python_package
done

install_wheel_into_venv
echo "✅ Build complete. Wheel artifacts are in: $DIST_DIR/"
