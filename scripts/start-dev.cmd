@echo off
REM Task Scheduler entry: Mongo + backend + frontend. Stays in the foreground of its own task.
cd /d "%~dp0.."
npm run dev > "%TEMP%\stack_dev.log" 2>&1
