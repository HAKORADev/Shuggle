@echo off
title Shuggle - Local Network
cd /d "%~dp0"
echo.
echo   Shuggle is opening to your local network.
echo   People on the same Wi-Fi can open the link below in their browser.
echo   Keep this window open while they use it. Press Ctrl+C to stop.
echo.
Shuggle.exe serve --lan
