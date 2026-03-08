#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ROOT_DIR}/.tools/gitleaks"
BIN_PATH="${BIN_DIR}/gitleaks"
VERSION="${GITLEAKS_VERSION:-8.30.0}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "${arch}" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *)
    echo "Unsupported architecture: ${arch}" >&2
    exit 1
    ;;
esac

case "${os}" in
  linux|darwin) ;;
  *)
    echo "Unsupported operating system: ${os}" >&2
    exit 1
    ;;
esac

download_gitleaks() {
  local url="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${os}_${arch}.tar.gz"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' RETURN

  mkdir -p "${BIN_DIR}"
  curl -fsSL "${url}" -o "${tmp_dir}/gitleaks.tar.gz"
  tar -xzf "${tmp_dir}/gitleaks.tar.gz" -C "${tmp_dir}"
  mv "${tmp_dir}/gitleaks" "${BIN_PATH}"
  chmod +x "${BIN_PATH}"
}

if [[ ! -x "${BIN_PATH}" ]]; then
  echo "Installing gitleaks v${VERSION}..." >&2
  download_gitleaks
fi

exec "${BIN_PATH}" "$@"
