@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  if exist "D:\Node.js\node.exe" (
    set "zhisuda_node=D:\Node.js\node.exe"
  ) else (
    echo Node.js 22 or newer is required. See README.md for setup.
    pause
    exit /b 1
  )
) else (
  set "zhisuda_node=node"
)
"%zhisuda_node%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 22 or newer is required. See README.md.
  pause
  exit /b 1
)
"%zhisuda_node%" --input-type=module -e "await Promise.all(['unpdf','fast-xml-parser','fflate'].map(name => import(name)))" >nul 2>&1
if errorlevel 1 (
  echo Project dependencies are missing. In this folder, run:
  echo npm ci --ignore-scripts --omit=optional
  echo This installs project packages only. See README.md for details.
  pause
  exit /b 1
)
title Zhisuda - local review workbench
echo Starting the local workbench. Keep this window open.
echo Default address: http://127.0.0.1:3000
echo The exact address will appear below. Press Ctrl+C to stop.
"%zhisuda_node%" --env-file-if-exists=.env server.js
if errorlevel 1 pause
endlocal
