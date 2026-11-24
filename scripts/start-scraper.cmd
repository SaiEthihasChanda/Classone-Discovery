@echo off
REM Task Scheduler entry: the Python scraper service.
REM Logs go to a fixed project-relative path, not %TEMP% — see start-dev.cmd.
cd /d "%~dp0.."
if not exist logs mkdir logs
cd scraper-service
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 > "..\logs\scraper_out.log" 2>&1
