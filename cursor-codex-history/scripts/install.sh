#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILL_NAME="cursor-codex-history"

INSTALL_MODE="symlink"
WITH_SERVICE="yes"
FORCE="no"
DRY_RUN="no"
FULL_SCAN_MINUTES="10"
DEBOUNCE_MS="2000"

CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex/skills}"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="cursor-codex-history-sync.service"
SERVICE_PATH="${SERVICE_DIR}/${SERVICE_NAME}"
TARGET_SKILL_PATH="${CODEX_SKILLS_DIR}/${SKILL_NAME}"

print_help() {
  cat <<USAGE
Install cursor-codex-history for Codex/Cursor.

Usage:
  bash scripts/install.sh [options]

Options:
  --symlink               Install as symlink (default)
  --copy                  Install as physical copy
  --with-service          Install and enable systemd user service (default)
  --without-service       Only install skill, no service
  --full-scan-minutes N   Service full scan interval (default: 10)
  --debounce-ms N         Service debounce milliseconds (default: 2000)
  --force                 Replace existing installation
  --dry-run               Print actions without changing system
  -h, --help              Show help

Environment:
  CODEX_HOME              Defaults to ~/.codex
  XDG_CONFIG_HOME         Defaults to ~/.config
USAGE
}

log() {
  echo "[install] $*"
}

warn() {
  echo "[install][warn] $*" >&2
}

run_cmd() {
  if [[ "$DRY_RUN" == "yes" ]]; then
    echo "[dry-run] $*"
  else
    eval "$*"
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

is_user_systemd_available() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active default.target >/dev/null 2>&1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --symlink)
      INSTALL_MODE="symlink"
      shift
      ;;
    --copy)
      INSTALL_MODE="copy"
      shift
      ;;
    --with-service)
      WITH_SERVICE="yes"
      shift
      ;;
    --without-service)
      WITH_SERVICE="no"
      shift
      ;;
    --force)
      FORCE="yes"
      shift
      ;;
    --dry-run)
      DRY_RUN="yes"
      shift
      ;;
    --full-scan-minutes)
      FULL_SCAN_MINUTES="$2"
      shift 2
      ;;
    --debounce-ms)
      DEBOUNCE_MS="$2"
      shift 2
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

require_command node

if [[ ! "$FULL_SCAN_MINUTES" =~ ^[0-9]+$ ]] || [[ "$FULL_SCAN_MINUTES" -le 0 ]]; then
  echo "Error: --full-scan-minutes must be a positive integer" >&2
  exit 2
fi

if [[ ! "$DEBOUNCE_MS" =~ ^[0-9]+$ ]] || [[ "$DEBOUNCE_MS" -lt 100 ]]; then
  echo "Error: --debounce-ms must be an integer >= 100" >&2
  exit 2
fi

log "Project: ${PROJECT_DIR}"
log "Skill target: ${TARGET_SKILL_PATH}"
log "Install mode: ${INSTALL_MODE}"
log "Service install: ${WITH_SERVICE}"

if [[ "$DRY_RUN" == "yes" ]]; then
  echo "[dry-run] mkdir -p '${CODEX_SKILLS_DIR}'"
else
  if ! mkdir -p "${CODEX_SKILLS_DIR}"; then
    echo "Error: unable to create skill directory: ${CODEX_SKILLS_DIR}" >&2
    echo "Hint: check permissions or whether HOME/CODEX_HOME is writable." >&2
    exit 1
  fi
  if [[ ! -w "${CODEX_SKILLS_DIR}" ]]; then
    echo "Error: skill directory is not writable: ${CODEX_SKILLS_DIR}" >&2
    echo "Hint: run in a normal shell session (not read-only sandbox), or set writable CODEX_HOME." >&2
    exit 1
  fi
fi

if [[ -e "${TARGET_SKILL_PATH}" || -L "${TARGET_SKILL_PATH}" ]]; then
  if [[ "$FORCE" == "yes" ]]; then
    log "Replacing existing skill at ${TARGET_SKILL_PATH}"
    run_cmd "rm -rf '${TARGET_SKILL_PATH}'"
  else
    echo "Error: target already exists: ${TARGET_SKILL_PATH}. Re-run with --force to replace." >&2
    exit 1
  fi
fi

if [[ "$INSTALL_MODE" == "symlink" ]]; then
  run_cmd "ln -s '${PROJECT_DIR}' '${TARGET_SKILL_PATH}'"
else
  run_cmd "cp -R '${PROJECT_DIR}' '${TARGET_SKILL_PATH}'"
fi

SERVICE_STATE="not-requested"

if [[ "$WITH_SERVICE" == "yes" ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; service was not installed."
    warn "You can still use the CLI and run one-shot sync manually: npm run sync -- --once"
    SERVICE_STATE="skipped-no-systemctl"
  elif ! is_user_systemd_available; then
    warn "systemd user session is unavailable; service was not installed."
    warn "Try login shell / graphical session, then re-run:"
    warn "  bash scripts/install.sh --with-service --force"
    SERVICE_STATE="skipped-user-systemd-unavailable"
  else
    NODE_BIN="$(command -v node)"
    run_cmd "mkdir -p '${SERVICE_DIR}'"

    SERVICE_CONTENT="[Unit]
Description=Cursor Codex History Sync Daemon
After=default.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${PROJECT_DIR}/scripts/sync-daemon.js --full-scan-minutes ${FULL_SCAN_MINUTES} --debounce-ms ${DEBOUNCE_MS}
WorkingDirectory=${PROJECT_DIR}
Restart=always
RestartSec=5
Environment=CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
Environment=CURSOR_HOME=${CURSOR_HOME:-$HOME/.cursor}
Environment=CURSOR_CODEX_HISTORY_HOME=${CURSOR_CODEX_HISTORY_HOME:-$HOME/.cursor-codex-history}

[Install]
WantedBy=default.target
"

    if [[ "$DRY_RUN" == "yes" ]]; then
      echo "[dry-run] write service file to ${SERVICE_PATH}"
      echo "[dry-run] systemctl --user daemon-reload"
      echo "[dry-run] systemctl --user enable --now '${SERVICE_NAME}'"
      SERVICE_STATE="dry-run"
    else
      printf "%s" "$SERVICE_CONTENT" > "${SERVICE_PATH}"
      if systemctl --user daemon-reload && systemctl --user enable --now "${SERVICE_NAME}"; then
        SERVICE_STATE="enabled"
      else
        warn "Service file was written, but enabling service failed."
        warn "Retry manually:"
        warn "  systemctl --user daemon-reload"
        warn "  systemctl --user enable --now ${SERVICE_NAME}"
        SERVICE_STATE="write-only-enable-failed"
      fi
    fi
  fi
fi

log "Install completed."
log "Try: node '${PROJECT_DIR}/scripts/history-cli.js' reindex --json"
log "Or from any directory: node '${TARGET_SKILL_PATH}/scripts/history-cli.js' list --limit 20 --json"
if [[ "$WITH_SERVICE" == "yes" ]]; then
  if [[ "$SERVICE_STATE" == "enabled" || "$SERVICE_STATE" == "dry-run" ]]; then
    log "Service status: systemctl --user status ${SERVICE_NAME}"
  else
    log "Service state: ${SERVICE_STATE} (CLI install succeeded)"
  fi
fi
