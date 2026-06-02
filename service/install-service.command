#!/bin/bash
# 將「法規更新查核」安裝為 macOS 背景常駐服務（launchd）：開機自動啟動、當掉自動重啟、免開 Terminal。
# 用法：
#   預設（只綁本機，安全）        ：雙擊本檔，或 ./service/install-service.command
#   開放區網給同事連（辦公室主機）：HOST=0.0.0.0 ./service/install-service.command
# 可一併指定 PORT、CHECK_HOUR（每天幾點自動查核，台灣＝9）。
set -e
cd "$(dirname "$0")/.."
PROJ="$(pwd)"
# Node 路徑：優先採穩定安裝路徑（Homebrew / 官方安裝器），避免 nvm/asdf 等版本管理器的 shim 在 launchd（精簡 PATH、無互動 shell）下失效
NODE=""
for p in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$p" ] && NODE="$p" && break; done
[ -z "$NODE" ] && NODE="$(command -v node || true)"
# 寫入 plist 前先做 XML 跳脫（路徑若含 & < > 才不會產生不合法 plist）
xmlesc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
LABEL="com.lawtracker.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-7843}"
HOST="${HOST:-127.0.0.1}"                 # 安全預設＝只綁本機；要開放區網請設 HOST=0.0.0.0
CHECK_HOUR="${CHECK_HOUR:-9}"            # 每天幾點（本機時間）自動查核到期任務；台灣＝9（早上 9 點）

if [ -z "$NODE" ]; then echo "✗ 找不到 Node.js，請先安裝 https://nodejs.org"; read -r -p "按 Enter 關閉…" _; exit 1; fi
mkdir -p "$HOME/Library/LaunchAgents" "$PROJ/data"
NODE_X="$(xmlesc "$NODE")"; PROJ_X="$(xmlesc "$PROJ")"   # plist 內用 XML 跳脫後的路徑

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_X</string>
    <string>$PROJ_X/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJ_X</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>$HOST</string>
    <key>CHECK_HOUR</key><string>$CHECK_HOUR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJ_X/data/server.log</string>
  <key>StandardErrorPath</key><string>$PROJ_X/data/server.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "✓ 已安裝並啟動背景服務：$LABEL"
echo "  設定： PORT=$PORT  HOST=$HOST  排程＝每天 ${CHECK_HOUR}:05 自動查核"
if [ "$HOST" = "0.0.0.0" ]; then
  IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<本機區網IP>')"
  echo "  區網連線： http://$IP:$PORT  （同事用此網址）"
  echo "  ⚠ 已開放區網且無登入密碼，請僅在信任的內部網路使用、勿曝露到網際網路。"
else
  echo "  本機連線： http://127.0.0.1:$PORT"
fi
echo "  記錄檔： $PROJ/data/server.log"
echo "  移除服務：執行 service/uninstall-service.command"
read -r -p "按 Enter 關閉…" _
