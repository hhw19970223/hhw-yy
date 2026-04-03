#!/usr/bin/env bash
# hhw-yy service manager
# Usage: ./service.sh {start|stop|restart|status|log}

PID_FILE=".hhw-yy.pid"
LOG_FILE="hhw-yy.log"
CMD="npx tsx src/main.ts config.json"

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "[hhw-yy] Already running (PID $(cat "$PID_FILE"))"
    exit 1
  fi
  nohup $CMD >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "[hhw-yy] Started (PID $!), logs → $LOG_FILE"
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "[hhw-yy] Not running (no PID file)"
    exit 1
  fi
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm -f "$PID_FILE"
    echo "[hhw-yy] Stopped (PID $PID)"
  else
    echo "[hhw-yy] Process $PID not found, removing stale PID file"
    rm -f "$PID_FILE"
  fi
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "[hhw-yy] Running (PID $(cat "$PID_FILE"))"
  else
    echo "[hhw-yy] Not running"
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
