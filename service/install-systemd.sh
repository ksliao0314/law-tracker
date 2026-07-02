#!/bin/bash
# 將「法規更新查核」安裝為 Linux systemd 背景常駐服務（GCP/雲端主機）：開機自啟、當掉自動重啟。
# 用法（用一般使用者執行，腳本內部各步才用 sudo；請「不要」用 sudo 執行整支）：
#   只綁本機（建議搭反向代理對外）： bash service/install-systemd.sh
#   開放區網／公開（務必設密碼）：    HOST=0.0.0.0 AUTH_PASS='你的密碼' bash service/install-systemd.sh
#   可一併指定 PORT、CHECK_HOUR、TZ。
set -e
cd "$(dirname "$0")/.."
PROJ="$(pwd)"

# 若整支被 sudo 執行，服務會以 root 常駐、$HOME 變 /root → 用原始使用者；純 root 登入直接擋
USERNAME="${SUDO_USER:-$(whoami)}"
if [ "$(id -u)" = 0 ] && [ -z "$SUDO_USER" ]; then
  echo "✗ 請勿以 root 直接執行整支腳本（服務會以 root 常駐、路徑也會錯）。請改用一般使用者：bash service/install-systemd.sh"; exit 1
fi
USER_HOME="$(eval echo "~$USERNAME")"

# Node 路徑：優先穩定安裝路徑（套件管理器 / NodeSource），避免 nvm shim 在 systemd 精簡環境下失效
NODE=""
for p in /usr/bin/node /usr/local/bin/node "$USER_HOME"/.nvm/versions/node/*/bin/node; do [ -x "$p" ] && NODE="$p" && break; done
[ -z "$NODE" ] && NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "✗ 找不到 Node.js。請先安裝（建議：sudo apt-get install -y nodejs，或用 NodeSource 取得 18+）"; exit 1; }

PORT="${PORT:-7843}"; HOST="${HOST:-127.0.0.1}"; CHECK_HOUR="${CHECK_HOUR:-9}"; TZ_SET="${TZ:-Asia/Taipei}"
LABEL="lawtracker"; UNIT="/etc/systemd/system/$LABEL.service"; ENVFILE="/etc/$LABEL.env"

# 是否為「僅本機」位址（別名一併視為本機，避免誤判為對外）
case "$HOST" in 127.0.0.1|localhost|::1) LOCAL=1;; *) LOCAL=0;; esac
# 對外卻沒設密碼 → 警告（當事人資料會任人讀寫）
if [ "$LOCAL" = 0 ] && [ -z "$AUTH_PASS" ]; then
  echo "⚠ 你設了 HOST=$HOST（對外）但未設 AUTH_PASS —— 任何能連到此服務的人都能讀寫當事人資料。"
  echo "  強烈建議：HOST=$HOST AUTH_PASS='一組密碼' bash service/install-systemd.sh"
  read -r -p "仍要在無密碼下繼續？輸入 yes 確認： " ans; [ "$ans" = "yes" ] || { echo "已中止。"; exit 1; }
fi

echo "→ Node：$NODE （$("$NODE" -v 2>/dev/null)）    使用者：$USERNAME    專案：$PROJ"
mkdir -p "$PROJ/data"

# 設定與機密寫入「只有 root 可讀」的 env 檔（密碼不放進 world-readable 的 unit）
sudo tee "$ENVFILE" >/dev/null <<EOF
HOST=$HOST
PORT=$PORT
CHECK_HOUR=$CHECK_HOUR
TZ=$TZ_SET
EOF
if [ -n "$AUTH_PASS" ]; then
  case "$AUTH_PASS" in *\'*) echo "⚠ AUTH_PASS 含單引號，systemd 可能解析錯誤，建議改用不含單引號的密碼。";; esac
  # 單引號包裹，讓含空白/特殊字元的密碼被 systemd 當字面值（避免去空白/去引號造成登入失敗）
  printf "AUTH_PASS='%s'\n" "$AUTH_PASS" | sudo tee -a "$ENVFILE" >/dev/null
fi
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

# 排程說明與 server.mjs 一致：僅 0–23 才每日排程，否則「僅開頁時查核」
if [ "$CHECK_HOUR" -ge 0 ] 2>/dev/null && [ "$CHECK_HOUR" -le 23 ] 2>/dev/null; then SCHED="每天 ${CHECK_HOUR}:05 自動查核"; else SCHED="排程已關閉（僅開頁時查核）"; fi

echo ""
if sudo systemctl is-active --quiet "$LABEL"; then echo "✓ 已安裝並啟動：$LABEL"; else echo "✗ 服務未能啟動，請看：journalctl -u $LABEL -n 30"; fi
echo "  設定：PORT=$PORT  HOST=$HOST  時區=$TZ_SET  $SCHED${AUTH_PASS:+  （已設登入密碼）}"
echo "  狀態：sudo systemctl status $LABEL     日誌：journalctl -u $LABEL -f"
echo "  健康檢查：curl http://127.0.0.1:$PORT/healthz"
echo "  停止移除：sudo systemctl disable --now $LABEL && sudo rm -f $UNIT $ENVFILE && sudo systemctl daemon-reload"
[ "$LOCAL" = 1 ] && echo "  目前只綁本機。要用網域對外，請架反向代理 + HTTPS（見 README「模式 C」）。"
