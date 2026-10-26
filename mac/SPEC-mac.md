# Work Time Tracker — Mac 版 (v2.0)

元: github.com/ysato201087-pixel/WorkTimeTracker (Windows 向け v1.0.0)。v1.0 の Mac 対応では本体は無改造。v1.1 以降は本体も変更 (下記)。

## 構成
- URL: http://127.0.0.1:8775
- サーバー: LaunchAgent `com.ysato.worktimetracker` (ログイン時に自動起動・常駐。KeepAlive、落ちたら30秒間隔で再起動)
- アプリ: `~/Applications/Work Time Tracker.app`
  - サーバーが止まっていれば起こす。起動できなければアラートでログの場所を表示
  - Chrome のアプリウィンドウ (410x455) で開く。窓が既にあれば前面に出すだけ、窓を閉じた後なら1枚開き直す (許可不要)
  - サーバーが未登録なら登録し直してから起動。初回のみ窓位置を指定し、以降は Chrome が覚えた位置
  - Chrome が無ければ既定ブラウザで開く
  - ログが 1MB を超えたら起動時に切り詰める
- データ: data/work-time-tracker.sqlite / ログ: data/server.*.log
- Node.js 24 以上必須 (node:sqlite)。setup 時に検証

## 操作
- 初回 / 作り直し: `mac/setup.command` を実行
- 本体更新後: `git pull` → `launchctl kickstart -k gui/$UID/com.ysato.worktimetracker`
- mac/ 内のファイルが変わったら: `mac/setup.command` を再実行
- 削除: `launchctl bootout gui/$UID/com.ysato.worktimetracker` → `~/Library/LaunchAgents/com.ysato.worktimetracker.plist` 、`~/Applications/Work Time Tracker.app`、`data/browser-profile` を削除

## 既知の制限
- 元アプリの仕様で、履歴はプロジェクトごとに最新10件だけ残り、それより古いものは DB から削除される。累計もその10件の合計
- Windows 版のタスクトレイ機能は無し。窓は Chrome として Dock に出る
- スリープ中も計測時間に加算される
- launchd 停止時 (SIGTERM) は DB を明示 close しない (WAL のため実害は小さい)
- システム設定 > ログイン項目に表示される

## 残課題 (レビューで出た改善案)
- 窓を最小化中にアイコンを押しても最小化は解けない (Dock の Chrome アイコンから戻す)
- 他アプリの後ろにある窓が前面に来ない可能性 (macOS 14+ の前面化制限。実機で要確認)
- 根本対策案: Safari の「Dock に追加」方式への切り替え
- 8775 を他プロセスが使用中だと起動失敗が続く (アラートで通知はされる)
- パスに `"` や `|` を含む場所に置くと setup が壊れる
- ログの切り詰めはアイコン起動時のみ
- 10件制限の撤廃 (表示だけ10件に) / CSV 書き出し / 日・週集計
- 窓タイトルに経過時間を表示、またはメニューバー表示
- 放置・スリープ時間の除外

---

# v1.1 追加仕様 (2026-10-21)

## 1. 記録の保持期間とバックアップ
- 10件制限を廃止 (削除処理 enforceEntryLimit と、一覧・合計の `entry_rank <= 10` の両方)
- 保持範囲: 「ローカル時刻で前月1日 00:00」以降に開始した記録 (= 前月全体 + 今月。月単位で集計できる)
- それより前に開始した記録は「保管」する:
  - 1つのトランザクション (BEGIN IMMEDIATE、同期処理のみ) で
    `archived_entries` へ INSERT → `projects.archived_seconds` に加算 → `time_entries` から DELETE
  - その後、影響した月の CSV を archived_entries から作り直す (上書きなので重複しない)
  - CSV: `data/backup/entries-YYYY-MM.csv` (ローカル時刻の開始月)。UTF-8 BOM 付き
  - 列: 記録ID, プロジェクトID, プロジェクト名, 開始, 終了 (ローカル `YYYY-MM-DD HH:mm:ss`), 作業秒, 作業時間(h:mm:ss), 一時停止秒
  - 値は `"` でくくってエスケープ。`= + - @` で始まる値は先頭に `'` を付ける
  - タイミング: サーバー起動時 + 6時間ごと
- 累計 = archived_seconds + 残っている記録の合計
- DB 移行 (起動時、`PRAGMA user_version` < 1 のとき1回だけ):
  - 移行前に sqlite を `data/backup/pre-v1.1-<日時>.sqlite` へコピー
  - `ALTER TABLE projects ADD COLUMN archived_seconds`
  - `archived_entries` テーブルを作成
  - インデックス `time_entries(started_at)`, `time_entries(project_id, started_at)` を作成
  - 以前の10件制限で消えた記録は戻らない
- プロジェクト削除時は、そのプロジェクトの残っている記録も archived_entries / CSV に移してから削除する (同一トランザクション)
- 起動時、archived_entries にあるのに CSV が無い月は作り直す。CSV は tmp に書いてから置き換える
- CSV のプロジェクト名は保管した時点の名前
- 移行前のバックアップは同じ日に1つだけ

## 2. 記録一覧に日別合計
- データ源は /api/state (残っている記録を全件返す)
- 記録一覧の上部に切り替え「履歴 | 日別」(セグメント)。選んだ表示は記憶する
- 履歴: 残っている記録を全件、新しい順に表示 (編集・削除も全件可能)
- 日別: 日付ごと (新しい順) に、その日の合計と、プロジェクトごとの合計を表示
  - プロジェクトで絞り込み中は、そのプロジェクトの日別合計だけ
  - 日付は記録の開始時刻 (ローカル時刻) で振り分ける。日をまたぐ記録も開始日に計上する
  - 計測中のタイマーは「今日」に加算して表示
  - 時間の表記は既存の formatDuration にそろえる
- 上部のまとめ:
  - 履歴表示中: 従来通り 累計
  - 日別表示中: 「最初の日 〜 合計」(日別の合計と一致する)。計測中は毎分更新

## 3. Dock に専用アイコン (Safari Web アプリ)
- ページに Web アプリ用の情報を追加:
  - manifest.json (name, display: standalone, icons 512px)
  - apple-touch-icon (180px、余白なしの全面背景)
  - `apple-mobile-web-app-title` = Work Time Tracker
- アイコンは mac/icon.svg を元に、全面背景版の PNG を生成。サーバーに .png の配信を追加
- Web アプリとして開いているとき (`display-mode: standalone`) は、記録一覧を別ウィンドウではなく画面内のダイアログで開く
- 窓を閉じても計測はサーバー側で続くので、閉じるときの確認 (beforeunload) は廃止
- 移行手順:
  1. setup.command を実行: LaunchAgent の登録だけを行う。旧 Chrome 方式の .app と browser-profile を削除し、plist の AssociatedBundleIdentifiers も外す
  2. 利用者が Safari で http://127.0.0.1:8775 を開き、「ファイル > Dockに追加」
  3. 万一 Safari で追加できない場合は `setup.command chrome` で旧 Chrome 方式の .app を作り直せる (launcher.sh は残す)
- サーバーの自動復旧は LaunchAgent の KeepAlive に任せる

## v1.1 残課題
- サーバー停止時の専用オフライン画面 (Service Worker)
- 日別の行を開いて、その日の記録を一覧・編集
- メイン画面に「今日の合計」、週の合計、期間を指定した CSV 書き出しボタン
- 残っている記録 (前月+今月) の定期スナップショット (VACUUM INTO)
- 小さい窓での記録一覧の高さ調整 / 手動追加で日付を選べるように
- 計測中を Dock のバッジや窓タイトルで表示、放置時間の検知

---

# v1.2 カテゴリ (2026-10-26)

プロジェクトを「カテゴリ > プロジェクト」の2階層にする。

## データ
- `categories` テーブル: id, name (大文字小文字を区別せず一意), created_at, updated_at
- `projects.category_id` (NULL = 未分類)
- プロジェクト名の一意性: 「全体で一意」から「同じカテゴリ内で一意」に変える
  - 一意インデックス `(COALESCE(category_id,''), name COLLATE NOCASE)` を使う。未分類 (NULL) どうしの重複も防げる
- 名前は前後の空白を削り、NFKC で正規化する (全角・半角の揺れをなくす)
  - 「未分類」は予約語。カテゴリ名に入れたら空欄と同じ扱い
- 既存のプロジェクトは全部「未分類」に入れる
- archived_entries に `category_name TEXT NOT NULL DEFAULT ''` を追加する
  - CSV に「カテゴリ」列を足す (プロジェクト名の前)
  - 移行後に、全部の月の CSV を作り直す。1行目に「カテゴリ」が無い CSV は、起動時にも作り直す

### 移行 (user_version 1 → 2)
migrate() は、バージョンを順番に適用する形にする。

1. `VACUUM INTO data/backup/pre-v1.2-<日時>.sqlite` でバックアップを取る (同じ日に1つだけ)
2. **BEGIN より前に** `PRAGMA foreign_keys=OFF` にする (トランザクションの中では切り替えられない。ON のまま DROP すると CASCADE で記録が全部消えるため)
3. `BEGIN IMMEDIATE`
4. categories を作る
5. `projects_new` を作る (archived_seconds と category_id を含む)
6. id をそのまま移す。名前は NFKC と trim で正規化し、重複したら「 (2)」などを付けてログに出す
7. `DROP TABLE projects` してから、`ALTER TABLE projects_new RENAME TO projects`
   - projects 自体を先にリネームしない (そうすると参照している側の外部キーまで書き換わってしまう)
8. 一意インデックスを作る。archived_entries に列を足す
9. 確認する。どれかが成り立たなければ ROLLBACK
   - `PRAGMA foreign_key_check` が空
   - projects / time_entries の件数が移行の前後で同じ
10. `user_version=2` にして COMMIT
11. finally で `PRAGMA foreign_keys=ON` に戻す
- 失敗したら、エラーを server.err.log に出して終了する (データは変わらない)

## メイン画面
- 入力欄を縦に2つ並べる。上が「カテゴリ」、下が「プロジェクト」
  - ラベルは無くし、プレースホルダーだけにする: 「カテゴリ (なしで未分類)」「プロジェクト」
  - 410x455 の窓にボタンまで収まるように、余白を詰める
- プロジェクト欄 (こちらが主役)
  - カテゴリ欄が空なら、候補は全プロジェクト (最近使った順)
    - 各候補にカテゴリ名を小さく添える
    - 検索はカテゴリ名にも当たる (「ABC」と打つと ABC の子が出る)
    - 選ぶとカテゴリ欄も埋まる
  - カテゴリ欄が入っていれば、候補はそのカテゴリの子だけ (最近使った順)
- カテゴリ欄
  - 候補は既存のカテゴリ
  - 変えたとき、プロジェクト欄が「候補から選んだもの」で、それが新しいカテゴリに無ければ、プロジェクト欄を空にする
  - 手で打ちかけの名前は残す
  - 選んでいたものと同じ名前のプロジェクトが新しいカテゴリにあれば、そちらに切り替える
  - 候補から選んだ後で文字を書き換えたら、手で打った扱いに戻す
- スタート時に何を使うか
  - 候補から選んだプロジェクト → その id を使う
  - 手で打ったとき、カテゴリ欄あり → そのカテゴリ内で名前を探す。無ければ作る (カテゴリも無ければ作る)
  - 手で打ったとき、カテゴリ欄なし → 全体で同じ名前を探す
    - 1件 → それを使う
    - 2件以上 → 「カテゴリを選んでください」と出す
    - 0件 → 未分類に作る
- 計測中は両方の欄をロックして、計測中のカテゴリ・プロジェクトを表示する (activeTimer に categoryId と categoryName を追加)
- 「プロジェクト累計」は、カテゴリとプロジェクトの組で探したプロジェクトの累計

## 記録一覧
- 絞り込みの値: `all` / `cat:<id>` / `cat:none` (未分類) / `proj:<id>`
  - カテゴリごとにまとめて並べる (optgroup)
  - 先頭に「(カテゴリ) 全体」、続けて子プロジェクト
  - 中身が空のカテゴリも出す
- 履歴の各行は「カテゴリ / プロジェクト」と表示する (未分類はプロジェクト名だけ)
- 日別は次の順に表示する。子が1つだけでも同じ形
  - 日の合計
  - カテゴリごとの小計
  - その下に子プロジェクト
- 上部のまとめは、絞り込みに応じて累計 (カテゴリなら子の合計) と期間の合計を出す
- 「名称変更」は「編集」にする
  - プロジェクトを選んでいるとき: 名前とカテゴリを変えられる。移動先に同じ名前があれば 409 で知らせる (統合はしない)
  - カテゴリを選んでいるとき: カテゴリ名を変えられる
  - 「すべて」「未分類」を選んでいるときは無効
- 「削除」
  - プロジェクトを選んでいるとき: 従来通り (記録は CSV に移す)
  - カテゴリを選んでいるとき: カテゴリだけを削除し、中のプロジェクトは未分類へ移す (記録は消さない)
    - 未分類に同じ名前があれば、409 で衝突した名前を知らせ、何も変えない
  - 「すべて」「未分類」を選んでいるときは無効
- 手動追加の初期値
  - プロジェクトを選んでいるとき: そのプロジェクト
  - カテゴリを選んでいるとき: その最初の子
  - それ以外 (中身が空のカテゴリなど): 最近使ったプロジェクト
- 記録編集ダイアログのプロジェクト選択も、カテゴリごとにまとめて並べる

## API
- POST /api/timer/start: { projectId } または { categoryName, projectName }
- PUT /api/projects/:id: { name, categoryName? }
  - categoryName のキーが無い → カテゴリは変えない
  - 空文字 → 未分類
  - 存在しないカテゴリ → 作る
- PUT /api/categories/:id: { name }
  - 名前が衝突したら 409
  - 空欄や「未分類」なら 400
- DELETE /api/categories/:id
- /api/state
  - categories を追加
  - projects に categoryId と categoryName を追加
  - activeTimer に categoryId と categoryName を追加

## v1.2 残課題
- 候補の最後に「新規: ○○」の行を出す
- 同じ名前が2件以上ある時は、その候補だけをメニューで開く
- まだ無い組み合わせのときに、欄に「新規」の印を出す
- カテゴリの色分け、使わなくなったプロジェクトを隠す機能

---

# v1.2.1 「その他」カテゴリは今日の累計 (2026-10-26)

- 対象: カテゴリ名が「その他」のプロジェクト (NFKC 正規化後、大文字小文字を区別せず一致)
- メイン画面の累計欄
  - 見出しを「プロジェクト累計」から「今日の累計」に変える
  - 値は、そのプロジェクトのうち、開始日 (ローカル時刻) が今日の記録の合計
  - 日付が変わると自然に 0 から数え直す (画面の更新時に今日を判定する。データは消さない)
  - 計測中の時間は含めない (今の「プロジェクト累計」と同じ)
- 記録一覧 (履歴・日別・上部のまとめ) は変えない
- 日をまたいだ記録は開始日に計上する (日別と同じ)
- 判定はカテゴリ名なので、「その他」の名前を変えると通常の累計に戻る
- まだ無いプロジェクト名を打っている間も、カテゴリ欄が「その他」なら見出しは「今日の累計」
- 残課題: カテゴリごとの「毎日リセット」設定、全プロジェクトで「累計」と「今日」を並べて表示
