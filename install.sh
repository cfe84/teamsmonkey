#!/usr/bin/env bash
set -euo pipefail

repo="cfe84/teamsmonkey"
install_dir="${TEAMSMONKEY_INSTALL_DIR:-$HOME/.local/teamsmonkey}"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:arm64e)
    asset="teamsmonkey-darwin-arm64.zip"
    ;;
  Darwin:x86_64)
    asset="teamsmonkey-darwin-amd64.zip"
    ;;
  *)
    printf 'Unsupported platform: %s %s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

command -v curl >/dev/null || { printf 'curl is required\n' >&2; exit 1; }
command -v unzip >/dev/null || { printf 'unzip is required\n' >&2; exit 1; }

archive="$(mktemp "${TMPDIR:-/tmp}/teamsmonkey.XXXXXX.zip")"
trap 'rm -f "$archive"' EXIT

printf 'Downloading %s...\n' "$asset"
curl --fail --location --silent --show-error \
  "https://github.com/${repo}/releases/latest/download/${asset}" \
  --output "$archive"

mkdir -p "$install_dir"
unzip -oq "$archive" -d "$install_dir"
chmod +x "$install_dir/teamsmonkey"

if [[ "$(uname -s)" == "Darwin" ]]; then
  launchctl setenv WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS \
    "--remote-debugging-port=9223"
fi

"$install_dir/teamsmonkey" --service-install
printf 'Teamsmonkey installed in %s\n' "$install_dir"
