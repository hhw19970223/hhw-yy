#!/usr/bin/env bash
# SL service manager
# Usage: ./service.sh {start|stop|restart|status|log}

PID_FILE=".SL.pid"
LOG_FILE="SL.log"
CMD="env SL_DISABLE_MCP=1 npx tsx src/main.ts config.json"

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "[SL] Already running (PID $(cat "$PID_FILE"))"
    exit 1
  fi
  nohup $CMD >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "[SL] Started (PID $!), logs → $LOG_FILE"
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "[SL] Not running (no PID file)"
    exit 1
  fi
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm -f "$PID_FILE"
    echo "[SL] Stopped (PID $PID)"
  else
    echo "[SL] Process $PID not found, removing stale PID file"
    rm -f "$PID_FILE"
  fi
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "[SL] Running (PID $(cat "$PID_FILE"))"
  else
    echo "[SL] Not running"
  fi
}

case "$1" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  log)     tail -f "$LOG_FILE" ;;
  *)       echo "Usage: $0 {start|stop|restart|status|log}"; exit 1 ;;
esac
