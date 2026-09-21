@echo off
REM Task Scheduler entry: the roster orchestrator. Waits for the backend first.
REM Edit RESET_AT / INSTITUTIONS for the next run.
set RESET_AT=2026-09-21T09:15:00Z
set INSTITUTIONS=I162827531
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."
:wait
curl -s -o nul -m 2 http://localhost:4000/api/health && goto run
ping -n 4 127.0.0.1 > nul
goto wait
:run
python backend\src\scripts\rosterOrchestrator.py --institutions %INSTITUTIONS% --reset-at %RESET_AT% --threshold 70 --skip-phase-a --log "%TEMP%\roster_orchestrator.log" > "%TEMP%\roster_orchestrator.out" 2>&1
