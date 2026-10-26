#!/bin/bash
# 初回に1回だけ実行。サーバーをログイン時に自動起動する。
#   ./setup.command         … Safari の Web アプリ方式 (Safari で「ファイル > Dockに追加」)
#   ./setup.command chrome  … 旧方式: Chrome の窓で開く .app を ~/Applications に作る
set -e
MODE="${1:-safari}"
APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ysato.worktimetracker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || echo /usr/local/bin/node)"
if ! "$NODE" -e 'process.exit(+process.versions.node.split(".")[0]>=24?0:1)' 2>/dev/null; then
  osascript -e 'display alert "Work Time Tracker" message "Node.js 24 以上が必要です" as critical'
  exit 1
fi
APP="$HOME/Applications/Work Time Tracker.app"

mkdir -p "$HOME/Library/LaunchAgents" "$APP_ROOT/data"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>--no-warnings</string><string>$APP_ROOT/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>8775</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$APP_ROOT/data/server.out.log</string>
  <key>StandardErrorPath</key><string>$APP_ROOT/data/server.err.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for i in 1 2 3 4 5; do launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break; sleep 1; done
if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  osascript -e 'display alert "Work Time Tracker" message "サーバーを登録できませんでした" as critical'
  exit 1
fi

# 自分たちが作った Chrome 方式の .app かどうか (Safari が作った同名の Web アプリは消さない)
is_our_app() {
  [ -f "$APP/Contents/Info.plist" ] && \
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null)" = "$LABEL.app" ]
}

wait_health() {
  for i in $(seq 1 20); do curl -sf -m 1 http://127.0.0.1:8775/api/health >/dev/null && return 0; sleep 0.5; done
  osascript -e 'display alert "Work Time Tracker" message "サーバーが応答しません" as critical'; exit 1
}

if [ "$MODE" != "chrome" ]; then
  if is_our_app; then rm -rf "$APP"; fi
  rm -rf "$APP_ROOT/data/browser-profile"
  wait_health
  if [ ! -d "$APP" ]; then
    open -a Safari "http://127.0.0.1:8775"
    osascript -e 'display dialog "Safari のメニュー「ファイル > Dockに追加」を選んでください。" with title "Work Time Tracker" buttons {"OK"} default button 1' >/dev/null 2>&1 || true
  fi
  echo "完了: http://127.0.0.1:8775"
  exit 0
fi

# ---- 以下 chrome 方式 ----
if [ -d "$APP" ] && ! is_our_app; then
  osascript -e 'display alert "Work Time Tracker" message "~/Applications に同名のアプリがあります (Safari の Web アプリ)。" as critical'
  exit 1
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
sed "s|__APP_ROOT__|$APP_ROOT|" "$APP_ROOT/mac/launcher.sh" > "$APP/Contents/MacOS/WorkTimeTracker"
chmod +x "$APP/Contents/MacOS/WorkTimeTracker"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Work Time Tracker</string>
  <key>CFBundleDisplayName</key><string>Work Time Tracker</string>
  <key>CFBundleIdentifier</key><string>$LABEL.app</string>
  <key>CFBundleExecutable</key><string>WorkTimeTracker</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(cat "$APP_ROOT/VERSION")</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL

# アイコン (SVG → icns)。失敗してもアプリ自体は使えるので止めない
set +e
TMP="$(mktemp -d)"
qlmanage -t -s 1024 -o "$TMP" "$APP_ROOT/mac/icon.svg" >/dev/null 2>&1
SET="$TMP/AppIcon.iconset"; mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.svg.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$TMP/icon.svg.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$TMP"
touch "$APP"
set -e

wait_health

echo "完了: http://127.0.0.1:8775  /  $APP"
