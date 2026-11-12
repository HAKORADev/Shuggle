@echo off
title Shuggle CLI
cd /d "%~dp0"
Shuggle.exe cli
pause
@echo off
title Shuggle - Terminal
cd /d "%~dp0"
rem Interactive chat in this window. Ctrl+C to leave.
Shuggle.exe cli %*
