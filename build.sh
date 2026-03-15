set -euo pipefail

detect_arch() {
  case "$(uname -m)" in
    x86_64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "" ;;
  esac
}

DEFAULT_ARCHES="$(detect_arch)"
if [ -z "$DEFAULT_ARCHES" ]; then
  DEFAULT_ARCHES="x64 arm64"
fi

ARCHES=${ARCHES:-"$DEFAULT_ARCHES"}

for arch in $ARCHES; do
  pkg app.js --targets "node18-linux-$arch" --output "dist/appimage-manager-linux-$arch" --assets "app.html"
done
