# Work Time Tracker

Small local work-time tracker for Windows.

Data is stored locally in `data/work-time-tracker.sqlite`. No sign-in, cloud sync, or internet connection is required.

Current version: `1.0.0`

## Start

From PowerShell:

```powershell
.\Start-WorkTimeTracker.ps1
```

Or double-click this file. This is the recommended Windows launcher because it does not open a command prompt window.

```text
Start-WorkTimeTracker.vbs
```

`Start-WorkTimeTracker.cmd` is kept as a fallback and delegates to the `.vbs` launcher.

If script execution is blocked, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-WorkTimeTracker.ps1
```

The UI itself is Japanese. The PowerShell launcher text is intentionally ASCII-only so Windows PowerShell 5.1 can run it without UTF-8 parsing issues.

## Distribution

This app is distributed as a source ZIP. Users need Node.js 24 or later installed.

To create a release archive:

```powershell
.\scripts\package-release.ps1
```

The archive is written to:

```text
dist/work-time-tracker-v1.0.0.zip
```

Runtime files under `data/` are intentionally excluded from GitHub and release archives.

## Implemented

- Create or select projects
- Start, pause, resume, and stop one active timer
- Exclude paused time from active work time
- Store projects, entries, and active timer state in SQLite
- Restore a running or paused timer after app restart
- Show project totals calculated from saved entries
- Show, edit, and delete work history
- Rename and delete projects
- Windows task tray menu: open, pause, resume, stop, exit

## Notes

This MVP uses Node.js 24 `node:sqlite` and a local browser UI because the current workspace does not include a Tauri/Rust build toolchain. The API and SQLite schema are shaped so they can be migrated into a Tauri shell later.
