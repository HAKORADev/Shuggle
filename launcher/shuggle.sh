#!/usr/bin/env bash
cd "$(dirname "$0")"

# If the executable is still in pieces (downloaded in parts), join it first.
if [ ! -f ./shuggle ] && [ -f ./shuggle.part1 ]; then
  echo "  Joining the downloaded parts..."
  cat ./shuggle.part* > ./shuggle
  rm -f ./shuggle.part*
  chmod +x ./shuggle
fi

if [ ! -f ./shuggle ]; then
  echo
  echo "  shuggle is missing. Download the whole zip, or all the shuggle.part*"
  echo "  files into this folder and run this again."
  echo
  exit 1
fi

# Arguments pass straight through: ./shuggle.sh cli, ./shuggle.sh chat "hi", …
exec ./shuggle "$@"
