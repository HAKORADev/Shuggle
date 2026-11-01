@echo off
title Shuggle
cd /d "%~dp0"
rem %* passes any arguments through: "Shuggle.bat cli", "Shuggle.bat chat "hi"", …
Shuggle.exe %*
