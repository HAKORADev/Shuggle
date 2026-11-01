#!/usr/bin/env bash
cd "$(dirname "$0")"
# Arguments pass straight through: ./shuggle.sh cli, ./shuggle.sh chat "hi", …
exec ./shuggle "$@"
