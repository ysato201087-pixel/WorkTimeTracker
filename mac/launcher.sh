#!/bin/bash
# Work Time Tracker の .app 本体。サーバーを確認して、アプリ窓を開く(既に窓があれば前面へ)。
APP_ROOT="__APP_ROOT__"
PORT=8775
URL="http://127.0.0.1:$PORT"
LABEL="com.ysato.worktimetracker"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROFILE="$APP_ROOT/data/browser-profile"

alert() { osascript -e "display alert \"Work Time Tracker\" message \"$1\" as critical" >/dev/null 2>&1; }
alive() { curl -sf -m 1 "$URL/api/health" 2>/dev/null | grep -q '"ok":true'; }

# ログが 1MB を超えたら中身だけ切り詰める(launchd が開いたままのファイルを差し替えない)
for f in "$APP_ROOT"/data/server.*.log; do
  if [ -f "$f" ] && [ "$(stat -f%z "$f")" -gt 1048576 ]; then
    tail -c 200000 "$f" > "$f.tmp" && cat "$f.tmp" > "$f"; rm -f "$f.tmp"
  fi
done

if ! alive; then
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart "$DOMAIN/$LABEL" >/dev/null 2>&1
  elif [ -f "$PLIST" ]; then
    launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1
  fi
  for i in $(seq 1 40); do alive && break; sleep 0.25; done
  if ! alive; then
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1
    for i in $(seq 1 40); do alive && break; sleep 0.25; done
  fi
  if ! alive; then
    alert "起動できませんでした。mac/setup.command を再実行してください。\nログ: $APP_ROOT/data/server.err.log"
    exit 1
  fi
fi

# 既にアプリ窓があれば前面に出すだけ (許可不要)
PID="$(pgrep -f -- "--user-data-dir=$PROFILE" | while read p; do ps -o command= -p "$p" | grep -q -- "--type=" || echo "$p"; done | head -1)"
if [ -n "$PID" ]; then
  R="$(osascript -l JavaScript - "$PID" <<'JS' 2>/dev/null
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
function run(argv) {
  var pid = parseInt(argv[0]);
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)));
  var n = list.filter(function (w) {
    return w.kCGWindowOwnerPID == pid && w.kCGWindowLayer == 0 && w.kCGWindowBounds.Height > 80;
  }).length;
  if (n > 0) $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid).activateWithOptions(3);
  return n;
}
JS
)"
  [ "${R:-0}" -gt 0 ] && exit 0
fi

mkdir -p "$PROFILE"
if open -Ra "Google Chrome" >/dev/null 2>&1; then
  POS=""
  [ -f "$PROFILE/.positioned" ] || { POS="--window-position=120,120"; touch "$PROFILE/.positioned"; }
  # 同じプロファイルの Chrome が残っていれば、そこへ窓を1枚開くよう引数が渡される
  open -na "Google Chrome" --args --app="$URL" --window-size=410,455 $POS \
    --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check
else
  open "$URL"
fi
