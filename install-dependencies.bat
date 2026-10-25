@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title DLSite Manager NW - Install dependencies

echo ============================================
echo  DLSite Manager NW - dependency installer
echo ============================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found.
  echo Install Node.js from https://nodejs.org/ ^(it includes npm^) and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo package.json not found in this folder.
  echo Place this file in the application folder, next to package.json.
  echo.
  pause
  exit /b 1
)

set "MISSING="
for %%M in (dexie cheerio sql.js) do (
  if not exist "node_modules\%%M\package.json" set "MISSING=!MISSING! %%M"
)

if not defined MISSING (
  echo All dependencies are already installed. Nothing to do.
  echo.
  pause
  exit /b 0
)

echo Missing:%MISSING%
echo.
echo Installing...
echo.
call npm install%MISSING%
if errorlevel 1 (
  echo.
  echo Installation failed. Check the messages above and your internet connection.
  echo.
  pause
  exit /b 1
)

echo.
echo Done. All dependencies are installed.
echo.
pause
exit /b 0
