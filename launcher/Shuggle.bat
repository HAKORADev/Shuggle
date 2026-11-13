@echo off
title Shuggle
cd /d "%~dp0"

rem If the executable is still in pieces (downloaded in parts), join it first.
if not exist "Shuggle.exe" (
  if exist "Shuggle.exe.part1" (
    echo   Joining the downloaded parts...
    copy /b "Shuggle.exe.part*" "Shuggle.exe" >nul
    if exist "Shuggle.exe" del "Shuggle.exe.part*"
  )
)

if not exist "Shuggle.exe" (
  echo.
  echo   Shuggle.exe is missing. Download the whole zip, or all the
  echo   Shuggle.exe.part* files into this folder and run this again.
  echo.
  pause
  exit /b 1
)

rem %* passes any arguments through: "Shuggle.bat cli", "Shuggle.bat chat "hi"", …
Shuggle.exe %*
