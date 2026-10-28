#!/usr/bin/env bash
set -euo pipefail

# process-manager.sh — production load balancer / process manager for lumen-chain
# Uses native Node.js process manager (lumen-pm.js) for supervision.
#
# Commands:
#   start            start the service (background)
#   stop             stop the service gracefully
#   restart          restart the service
#   status           show status and health
#   logs             tail worker logs
#   health           curl the health endpoint
#
# Env overrides:
#   LUMEN_WORKERS, LUMEN_MODE, LUMEN_PEERS, LUMEN_BASE_PORT, etc.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PM_JS="${SCRIPT_DIR}/lumen-pm.js"
PID_FILE="${SCRIPT_DIR}/run/lumen-pm.pid"
LOG_DIR="${SCRIPT_DIR}/logs"
HEALTH_PORT="${LUMEN_HEALTH_PORT:-9400}"

export LUMEN_LOG_DIR="${LUMEN_LOG_DIR:-${LOG_DIR}}"
export LUMEN_PID_FILE="${LUMEN_PID_FILE:-${PID_FILE}}"

mkdir -p "${LOG_DIR}" "$(dirname "${PID_FILE}")"

start_pm() {
  if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}" 2>/dev/null || echo 0)" 2>/dev/null; then
    echo "lumen-chain process manager is already running (pid $(cat "${PID_FILE}"))"
    exit 0
  fi
  echo "Starting lumen-chain process manager..."
  cd "${REPO_ROOT}"
  nohup node "${PM_JS}" start >> "${LOG_DIR}/pm.out.log" 2>&1 &
  disown || true
  sleep 2
  if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}" 2>/dev/null || echo 0)" 2>/dev/null; then
    echo "lumen-chain process manager started (pid $(cat "${PID_FILE}"))"
  else
    echo "Failed to start process manager — check ${LOG_DIR}/pm.out.log"
    exit 1
  fi
}

stop_pm() {
  if [ ! -f "${PID_FILE}" ] || ! kill -0 "$(cat "${PID_FILE}" 2>/dev/null || echo 0)" 2>/dev/null; then
    echo "lumen-chain process manager is not running"
    # cleanup stale pid file
    rm -f "${PID_FILE}"
    exit 0
  fi
  echo "Stopping lumen-chain process manager..."
  local pid
  pid="$(cat "${PID_FILE}")"
  kill -TERM "$pid" 2>/dev/null || true
  # Wait up to 15s for graceful shutdown
  for i in $(seq 1 15); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "${PID_FILE}"
      echo "lumen-chain process manager stopped"
      return
    fi
    sleep 1
  done
  # Force kill if still running
  echo "Force killing..."
  kill -KILL "$pid" 2>/dev/null || true
  sleep 1
  rm -f "${PID_FILE}"
  echo "lumen-chain process manager stopped (forced)"
}

restart_pm() {
  echo "Restarting lumen-chain process manager..."
  stop_pm
  sleep 1
  start_pm
}

status_pm() {
  if [ ! -f "${PID_FILE}" ] || ! kill -0 "$(cat "${PID_FILE}" 2>/dev/null || echo 0)" 2>/dev/null; then
    echo "Status: stopped"
    exit 1
  fi
  echo "Status: running (pid $(cat "${PID_FILE}"))"
  echo ""
  if command -v curl >/dev/null 2>&1; then
    curl -sf "http://127.0.0.1:${HEALTH_PORT}/health" || echo "Health endpoint not reachable yet"
  else
    echo "curl not available — view logs with: $0 logs"
  fi
}

logs_pm() {
  if [ ! -d "${LOG_DIR}" ]; then
    echo "No logs directory at ${LOG_DIR}"
    exit 1
  fi
  echo "=== Worker logs (Ctrl-C to exit) ==="
  tail -f "${LOG_DIR}"/lumen-*.log 2>/dev/null || echo "No worker logs yet"
}

health_pm() {
  curl -sf "http://127.0.0.1:${HEALTH_PORT}/health" || {
    echo "Health check failed — is the manager running?"
    exit 1
  }
}

case "${1:-}" in
  start)
    start_pm
    ;;
  stop)
    stop_pm
    ;;
  restart)
    restart_pm
    ;;
  status)
    status_pm
    ;;
  logs)
    logs_pm
    ;;
  health)
    health_pm
    ;;
  *)
    cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  start      Start the lumen-chain process manager
  stop       Stop the lumen-chain process manager
  restart    Restart the process manager
  status     Show process manager and worker status
  logs       Tail worker logs
  health     Query health endpoint

Examples:
  $(basename "$0") start
  $(basename "$0") status
  $(basename "$0") logs
EOF
    exit 1
    ;;
esac
