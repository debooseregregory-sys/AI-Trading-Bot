@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 run_testnet.py
  goto :end
)
where python >nul 2>nul
if not errorlevel 1 (
  python run_testnet.py
  goto :end
)
echo Python 3 is niet gevonden. Installeer Python 3 of herstel de Python-installatie.
pause
:end
endlocal
