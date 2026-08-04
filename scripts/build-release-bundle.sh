#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
platform=${1:-linux}
arch=${2:-x64}
version=${3:-dev}
output_dir=${4:-$repo_dir/dist-release}
node_version=${BUZZ_DKG_NODE_VERSION:-22.14.0}

[ "$platform" = linux ] || { printf 'only linux bundles are supported\n' >&2; exit 2; }
case "$arch" in x64|arm64) ;; *) printf 'unsupported arch: %s\n' "$arch" >&2; exit 2 ;; esac
case "$version" in ''|*[!0-9A-Za-z._-]*) printf 'invalid version: %s\n' "$version" >&2; exit 2 ;; esac

for command in curl tar npm; do
  command -v "$command" >/dev/null 2>&1 || { printf '%s is required\n' "$command" >&2; exit 2; }
done

sha256_file() {
  path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    printf 'sha256sum or shasum is required\n' >&2
    exit 2
  fi
}

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/buzz-dkg-release.XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
bundle="$temp_dir/bundle"
mkdir -p "$bundle" "$output_dir"

for path in buzz-dkg package.json package-lock.json LICENSE NOTICE src scripts phase0 deploy; do
  cp -R "$repo_dir/$path" "$bundle/$path"
done

(
  cd "$bundle"
  npm ci --omit=dev --ignore-scripts
)

node_archive="node-v$node_version-linux-$arch.tar.xz"
node_base="https://nodejs.org/dist/v$node_version"
curl --fail --silent --show-error --location "$node_base/$node_archive" --output "$temp_dir/$node_archive"
curl --fail --silent --show-error --location "$node_base/SHASUMS256.txt" --output "$temp_dir/SHASUMS256.txt"
expected=$(awk -v file="$node_archive" '$2 == file { print $1; exit }' "$temp_dir/SHASUMS256.txt")
[ -n "$expected" ] || { printf 'Node checksum not found for %s\n' "$node_archive" >&2; exit 1; }
actual=$(sha256_file "$temp_dir/$node_archive")
[ "$expected" = "$actual" ] || { printf 'Node runtime checksum failed\n' >&2; exit 1; }

tar -xJf "$temp_dir/$node_archive" -C "$temp_dir"
mv "$temp_dir/node-v$node_version-linux-$arch" "$bundle/runtime"
printf '%s\n' "$version" > "$bundle/VERSION"
chmod 755 "$bundle/buzz-dkg" "$bundle/runtime/bin/node"

asset="$output_dir/buzz-dkg-$platform-$arch.tar.gz"
tar -czf "$asset" -C "$bundle" .
printf '%s  %s\n' "$(sha256_file "$asset")" "$(basename "$asset")" > "$asset.sha256"
printf '%s\n' "$asset"
