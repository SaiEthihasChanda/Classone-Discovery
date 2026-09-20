@echo off
REM Task Scheduler entry: the Python scraper service.
cd /d "%~dp0..\scraper-service"
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 > "%TEMP%\scraper_out.log" 2>&1
