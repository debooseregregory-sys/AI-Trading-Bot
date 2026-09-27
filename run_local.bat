@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 run_local.py
  if not errorlevel 1 goto :end
)
where python >nul 2>nul
if not errorlevel 1 (
  python run_local.py
  if not errorlevel 1 goto :end
)
for /d %%D in ("%LocalAppData%\Programs\Python\Python*") do (
  if exist "%%~fD\python.exe" (
    "%%~fD\python.exe" run_local.py
    if not errorlevel 1 goto :end
  )
)
echo Python 3 is niet gevonden. Installeer Python 3 of herstel de Python-installatie op deze pc.
pause
:end
endlocal
