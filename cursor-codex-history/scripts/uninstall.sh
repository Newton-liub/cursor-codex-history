#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILL_NAME="cursor-codex-history"

CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex/skills}"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="cursor-codex-history-sync.service"
SERVICE_PATH="${SERVICE_DIR}/${SERVICE_NAME}"
TARGET_SKILL_PATH="${CODEX_SKILLS_DIR}/${SKILL_NAME}"

REMOVE_DATA="no"
DRY_RUN="no"

print_help() {
  cat <<USAGE
Uninstall cursor-codex-history skill and service.

Usage:
  bash scripts/uninstall.sh [options]

Options:
  --remove-data      Also remove ~/.cursor-codex-history data directory
  --dry-run          Print actions only
  -h, --help         Show help
USAGE
}

run_cmd() {
  if [[ "$DRY_RUN" == "yes" ]]; then
    echo "[dry-run] $*"
  else
    eval "$*"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remove-data)
      REMOVE_DATA="yes"
      shift
      ;;
    --dry-run)
      DRY_RUN="yes"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_help
      exit 2
      ;;
  esac
 done

if command -v systemctl >/dev/null 2>&1; then
  run_cmd "systemctl --user disable --now '${SERVICE_NAME}' || true"
  if [[ -f "${SERVICE_PATH}" ]]; then
    run_cmd "rm -f '${SERVICE_PATH}'"
  fi
  run_cmd "systemctl --user daemon-reload"
fi

if [[ -e "${TARGET_SKILL_PATH}" || -L "${TARGET_SKILL_PATH}" ]]; then
  run_cmd "rm -rf '${TARGET_SKILL_PATH}'"
fi

if [[ "$REMOVE_DATA" == "yes" ]]; then
  HISTORY_HOME="${CURSOR_CODEX_HISTORY_HOME:-$HOME/.cursor-codex-history}"
  run_cmd "rm -rf '${HISTORY_HOME}'"
fi

echo "[uninstall] completed"
