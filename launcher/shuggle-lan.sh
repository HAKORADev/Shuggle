#!/usr/bin/env bash
cd "$(dirname "$0")"
echo
echo   Shuggle is opening to your local network.
echo   People on the same Wi-Fi can open the link below in their browser.
echo   Keep this window open while they use it. Press Ctrl+C to stop.
echo
exec ./shuggle serve --lan
