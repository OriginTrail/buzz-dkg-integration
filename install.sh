#!/bin/sh
set -eu

fail() {
  printf 'buzz-dkg bootstrap: %s\n' "$*" >&2
  exit 1
}

repo=OriginTrail/buzz-dkg-integration
release_base=https://github.com/$repo/releases/latest/download
install_root=${BUZZ_DKG_INSTALL_ROOT:-/usr/local/lib/buzz-dkg}
bin_dir=${BUZZ_DKG_BIN_DIR:-/usr/local/bin}
skip_launch=${BUZZ_DKG_SKIP_LAUNCH:-0}

command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"
command -v gh >/dev/null 2>&1 ||
  fail "GitHub CLI (gh) is required to authenticate the release attestation"

case "$(uname -s)" in
  Linux) platform=linux ;;
  *) fail "Beta V1 supports Linux only" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac

asset="buzz-dkg-$platform-$arch.tar.gz"
checksum_asset="$asset.sha256"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/buzz-dkg-bootstrap.XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM

download() {
  url=$1
  destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location "$url" --output "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
  else
    fail "curl or wget is required"
  fi
}

sha256_file() {
  path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

printf 'Downloading Buzz + DKG installer for %s/%s from %s...\n' "$platform" "$arch" "$release_base"
download "$release_base/$asset" "$temp_dir/$asset"
download "$release_base/$checksum_asset" "$temp_dir/$checksum_asset"

expected=$(awk 'NF { print $1; exit }' "$temp_dir/$checksum_asset")
actual=$(sha256_file "$temp_dir/$asset")
printf '%s\n' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$' ||
  fail "release checksum file is malformed"
[ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" = "$actual" ] ||
  fail "release checksum verification failed"

printf 'Authenticating GitHub build provenance...\n'
gh attestation verify "$temp_dir/$asset" --repo "$repo" >/dev/null ||
  fail "release provenance verification failed"

if tar -tvzf "$temp_dir/$asset" | awk '
  substr($1, 1, 1) !~ /^[-d]$/ { bad=1 }
  $NF ~ /^\// { bad=1 }
  { n=split($NF, p, "/"); for (i=1; i<=n; i++) if (p[i] == "..") bad=1 }
  END { exit bad ? 0 : 1 }
'; then
  fail "release archive contains an unsafe path or entry type"
fi

mkdir -p "$temp_dir/payload"
tar -xzf "$temp_dir/$asset" -C "$temp_dir/payload" --no-same-owner --no-same-permissions
chmod -R a-s "$temp_dir/payload"
[ -f "$temp_dir/payload/VERSION" ] || fail "release archive has no VERSION file"
[ -x "$temp_dir/payload/buzz-dkg" ] || fail "release archive has no executable CLI"
[ -x "$temp_dir/payload/runtime/bin/node" ] || fail "release archive has no bundled Node runtime"

version=$(tr -d '\r\n' < "$temp_dir/payload/VERSION")
case "$version" in
  ''|*[!0-9A-Za-z._-]*) fail "release VERSION is invalid" ;;
esac

release_dir="$install_root/releases/$version"
current_link="$install_root/current"
command_path="$bin_dir/buzz-dkg"

mkdir -p "$install_root/releases" "$bin_dir"
[ ! -e "$current_link" ] || [ -L "$current_link" ] ||
  fail "$current_link exists and is not a symlink; refusing to overwrite it"
if [ -e "$release_dir" ]; then
  [ -f "$release_dir/VERSION" ] || fail "existing release directory is not owned by buzz-dkg"
  [ "$(tr -d '\r\n' < "$release_dir/VERSION")" = "$version" ] ||
    fail "existing release directory has a mismatched version"
else
  staging="$install_root/releases/.install-$version-$$"
  [ ! -e "$staging" ] || fail "stale install staging path exists: $staging"
  mv "$temp_dir/payload" "$staging"
  chmod 755 "$staging/buzz-dkg" "$staging/runtime/bin/node"
  mv "$staging" "$release_dir"
fi

if [ -e "$command_path" ] && [ ! -L "$command_path" ]; then
  fail "$command_path exists and is not a symlink; refusing to overwrite it"
fi
if [ -L "$command_path" ]; then
  prior_target=$(readlink "$command_path" || true)
  case "$prior_target" in
    "$install_root"/*) ;;
    *) fail "$command_path is not managed by this installer; refusing to overwrite it" ;;
  esac
fi

replace_symlink() {
  target=$1
  link=$2
  temporary="$(dirname "$link")/.buzz-dkg-link-$$"
  rm -f "$temporary"
  ln -s "$target" "$temporary"
  if mv -Tf "$temporary" "$link" 2>/dev/null; then
    return
  fi
  # BSD mv has no -T. This fallback is used by local macOS tests; production
  # Linux hosts take the atomic rename path above.
  rm -f "$link"
  mv -f "$temporary" "$link"
}

replace_symlink "$release_dir" "$current_link"
replace_symlink "$current_link/buzz-dkg" "$command_path"

printf 'Installed buzz-dkg %s at %s\n' "$version" "$command_path"

if [ "$skip_launch" = 1 ]; then
  printf 'Run: sudo buzz-dkg install\n'
  exit 0
fi

printf 'Starting the Buzz-first installation wizard...\n'
if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  exec "$command_path" install </dev/tty >/dev/tty 2>&1
fi
exec "$command_path" install
