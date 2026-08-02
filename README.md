# 作業時間記録

Windows向けの小型ローカル作業時間記録アプリです。

プロジェクトごとに作業時間を計測し、合計時間と直近の履歴を確認できます。ユーザー登録、クラウド同期、インターネット接続は不要です。データはPC内のSQLiteファイルに保存されます。

現在のバージョン: `1.0.0`

## 必要環境

- Windows
- Node.js 24 以上
- Microsoft Edge または Google Chrome 推奨

## 起動方法

通常は、次のファイルをダブルクリックしてください。

```text
Start-WorkTimeTracker.vbs
```

この起動方法では、コマンドプロンプトの黒い画面を表示せずに起動できます。

PowerShellから起動する場合は、アプリのフォルダで次を実行します。

```powershell
.\Start-WorkTimeTracker.ps1
```

スクリプト実行がブロックされる場合は、次のコマンドで起動できます。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-WorkTimeTracker.ps1
```

`Start-WorkTimeTracker.cmd` は予備の起動ファイルです。内部的には `.vbs` 起動ファイルを呼び出します。

## 主な機能

- プロジェクトの作成と選択
- タイマーのスタート、一時停止、再開、ストップ
- 一時停止時間を除外した作業時間の記録
- プロジェクトごとの累計時間表示
- 作業時間の手動追加
- 直近10件までの作業履歴表示
- 作業履歴の編集と削除
- プロジェクト名の変更
- プロジェクト削除
- アプリ再起動後のタイマー復元
- SQLiteによるローカル保存
- Windowsタスクトレイからの操作
- 小型メインウィンドウと別ウィンドウの記録一覧

## データ保存場所

作業データは次のファイルに保存されます。

```text
data/work-time-tracker.sqlite
```

`data/` フォルダ内のDB、ログ、ブラウザプロファイルはGitHubや配布ZIPには含めません。

## 配布ZIPの作成

リリース用ZIPを作る場合は、アプリのフォルダで次を実行します。

```powershell
.\scripts\package-release.ps1
```

ZIPは次の場所に作成されます。

```text
dist/work-time-tracker-v1.0.0.zip
```

## GitHubで配布する場合

GitHub Releasesで `v1.0.0` のリリースを作成し、`dist/work-time-tracker-v1.0.0.zip` を添付すると、利用者がダウンロードしやすくなります。

## 補足

このバージョンは、Tauri/Rustのビルド環境がなくても動作確認しやすいように、Node.js 24 標準の `node:sqlite` とローカルWeb UIで構成しています。

将来的にTauriへ移行する場合も、現在のSQLiteスキーマとAPI設計を流用できます。

PowerShellランチャー内の表示文字列は、Windows PowerShell 5.1の文字コード問題を避けるため、一部英語表記にしています。アプリ画面本体は日本語です。
