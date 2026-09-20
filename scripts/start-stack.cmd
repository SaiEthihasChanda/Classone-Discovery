@echo off
REM Starts the whole local stack detached from whichever terminal invoked it:
REM   1. Mongo + backend + frontend   (npm run dev at the repo root)
REM   2. the Python scraper service   (uvicorn on 127.0.0.1:8000)
REM   3. the roster orchestrator      (only when RESET_AT is set)
REM
REM Meant to be run by Task Scheduler (see start-stack-task.cmd) so the
REM processes survive the closing of the terminal or agent session that
REM started them. Logs land in %TEMP%.
REM
REM   start-stack.cmd                       -> stack only
REM   set RESET_AT=2026-09-21T00:35:00Z & start-stack.cmd   -> stack + orchestrator

setlocal
set ROOT=%~dp0..
cd /d "%ROOT%"

REM --- 1. Mongo + backend + frontend -------------------------------------------
curl -s -o nul -m 2 http://localhost:4000/api/health
if errorlevel 1 (
  echo [stack] starting npm run dev
  start "ClassOne stack" /min cmd /c "npm run dev > "%TEMP%\stack_dev.log" 2>&1"
) else (
  echo [stack] backend already up
)

REM --- 2. scraper --------------------------------------------------------------
curl -s -o nul -m 2 http://127.0.0.1:8000/health
if errorlevel 1 (
  echo [stack] starting scraper
  start "ClassOne scraper" /min cmd /c "cd /d "%ROOT%\scraper-service" && .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 > "%TEMP%\scraper_out.log" 2>&1"
) else (
  echo [stack] scraper already up
)

REM --- 3. orchestrator (optional) ------------------------------------------------
if "%RESET_AT%"=="" goto :done
REM wait for the backend before launching it
set /a tries=0
:waitapi
curl -s -o nul -m 2 http://localhost:4000/api/health
if not errorlevel 1 goto :launch
set /a tries+=1
if %tries% geq 40 (
  echo [stack] backend did not come up; orchestrator not started
  goto :done
)
timeout /t 3 /nobreak > nul
goto :waitapi
:launch
echo [stack] starting orchestrator (reset at %RESET_AT%)
set PYTHONIOENCODING=utf-8
if "%INSTITUTIONS%"=="" set INSTITUTIONS=I162827531
start "ClassOne orchestrator" /min cmd /c "python backend\src\scripts\rosterOrchestrator.py --institutions %INSTITUTIONS% --reset-at %RESET_AT% --threshold 70 --log "%TEMP%\roster_orchestrator.log" > "%TEMP%\roster_orchestrator.out" 2>&1"

:done
echo [stack] done
endlocal
