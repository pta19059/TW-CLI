@echo off
setlocal
set SCRIPT_DIR=%~dp0
pushd "%SCRIPT_DIR%"

if not exist dist\index.js (
  call npm run build
)

if "%~1"=="" (
  node dist\index.js --help
) else (
  node dist\index.js %*
)

popd
endlocal
