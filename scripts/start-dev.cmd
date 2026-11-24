@echo off
REM Task Scheduler entry: Mongo + backend + frontend. Stays in the foreground of its own task.
REM Logs go to a fixed project-relative path, not %TEMP% — which resolves to a
REM different, less accessible folder when this runs as SYSTEM/a service account
REM instead of the interactive user (see "Run whether user is logged on or not").
cd /d "%~dp0.."
if not exist logs mkdir logs
npm run dev > "logs\stack_dev.log" 2>&1
