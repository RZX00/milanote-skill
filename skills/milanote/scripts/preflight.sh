#!/bin/sh
# Confirm the Milanote adapter is installed and registered. Does not open Chrome.
set -eu
PATH="$HOME/.hermes/node/bin:$HOME/.local/bin:$PATH"
export PATH
if ! command -v opencli >/dev/null 2>&1; then
  echo "milanote preflight: opencli is not on PATH. Install it with: npm install -g @jackwener/opencli@1.8.8" >&2
  exit 1
fi
if ! opencli milanote types -f json >/dev/null; then
  echo "milanote preflight: milanote commands are not registered" >&2
  exit 1
fi
echo "milanote preflight: ok $(command -v opencli)"
