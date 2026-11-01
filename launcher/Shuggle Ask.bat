@echo off
title Shuggle - One Question
cd /d "%~dp0"
rem Ask once and print the answer: "Shuggle Ask.bat what is a monad"
Shuggle.exe chat %*
