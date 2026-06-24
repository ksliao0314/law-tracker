#!/bin/bash
# 將「法規更新查核」安裝為 Linux systemd 背景常駐服務（GCP/雲端主機）：開機自啟、當掉自動重啟。
# 用法（需 sudo 權限）：
#   只綁本機（建議搭反向代理對外）： bash service/install-systemd.sh
#   開放區網／公開（務必設密碼）：    HOST=0.0.0.0 AUTH_PASS='你的密碼' bash service/install-systemd.sh
#   可一併指定 PORT、CHECK_HOUR、TZ。
set -e
cd "$(dirname "$0")/.."
PROJ="$(pwd)"
USERNAME="$(whoami)"

# Node 路徑：優先穩定安裝路徑（套件管理器 / NodeSource），避免 nvm shim 在 systemd 精簡環境下失效
NODE=""
for p in /usr/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$p" ] && NODE="$p" && break; done
[ -z "$NODE" ] && NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "✗ 找不到 Node.js。請先安裝（建議：sudo apt-get install -y nodejs，或用 NodeSource 取得 18+）"; exit 1; }
NODEV="$("$NODE" -v 2>/dev/null)"

PORT="${PORT:-7843}"; HOST="${HOST:-127.0.0.1}"; CHECK_HOUR="${CHECK_HOUR:-9}"; TZ_SET="${TZ:-Asia/Taipei}"
LABEL="lawtracker"
UNIT="/etc/systemd/system/$LABEL.service"
ENVFILE="/etc/$LABEL.env"

# 開放區網／公開卻沒設密碼 → 警告（當事人資料會任人讀寫）
if [ "$HOST" != "127.0.0.1" ] && [ -z "$AUTH_PASS" ]; then
  echo "⚠ 你設了 HOST=$HOST（非本機）但未設 AUTH_PASS —— 任何能連到此服務的人都能讀寫當事人資料。"
  echo "  強烈建議：HOST=$HOST AUTH_PASS='一組密碼' bash service/install-systemd.sh"
  read -r -p "仍要在無密碼下繼續？輸入 yes 確認： " ans; [ "$ans" = "yes" ] || { echo "已中止。"; exit 1; }
fi

echo "→ Node：$NODE （$NODEV）"
echo "→ 專案：$PROJ"
mkdir -p "$PROJ/data"

# 機密與設定寫入「只有 root 可讀」的 env 檔（密碼不放進 world-readable 的 unit）
sudo tee "$ENVFILE" >/dev/null <<EOF
HOST=$HOST
PORT=$PORT
CHECK_HOUR=$CHECK_HOUR
TZ=$TZ_SET
$( [ -n "$AUTH_PASS" ] && echo "AUTH_PASS=$AUTH_PASS" )
EOF
sudo chmod 600 "$ENVFILE"

sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=法規更新查核 (law-tracker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USERNAME
WorkingDirectory=$PROJ
EnvironmentFile=$ENVFILE
ExecStart=$NODE $PROJ/server.mjs
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$LABEL"
sleep 1
echo ""
if sudo systemctl is-active --quiet "$LABEL"; then echo "✓ 已安裝並啟動：$LABEL"; else echo "✗ 服務未能啟動，請看：journalctl -u $LABEL -n 30"; fi
echo "  設定：PORT=$PORT  HOST=$HOST  時區=$TZ_SET  排程＝每天 ${CHECK_HOUR}:05${AUTH_PASS:+  （已設登入密碼）}"
echo "  狀態：sudo systemctl status $LABEL"
echo "  日誌：journalctl -u $LABEL -f          健康檢查：curl http://127.0.0.1:$PORT/healthz"
echo "  停止移除：sudo systemctl disable --now $LABEL && sudo rm -f $UNIT $ENVFILE && sudo systemctl daemon-reload"
[ "$HOST" = "127.0.0.1" ] && echo "  目前只綁本機。要用網域對外，請架反向代理 + HTTPS（見 README「GCP / Linux 部署」）。"
