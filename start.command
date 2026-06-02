#!/bin/bash
# 雙擊此檔即可啟動「法規更新查核」工具。關閉本視窗或按 Ctrl-C 可停止。
cd "$(dirname "$0")"
PORT="${PORT:-7843}"
URL="http://127.0.0.1:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js，請先安裝（https://nodejs.org）後再試。"
  read -r -p "按 Enter 關閉…" _; exit 1
fi

echo "啟動中…稍候將自動開啟瀏覽器：${URL}"
( sleep 1.5; open "${URL}" ) &
exec node --max-old-space-size=2048 server.mjs
