#!/bin/bash
# 停止並移除「法規更新查核」的 macOS 背景常駐服務。
LABEL="com.lawtracker.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "✓ 已停止並移除背景服務：$LABEL"
echo "  （資料 data/ 不受影響，仍保留在本機。）"
read -r -p "按 Enter 關閉…" _
