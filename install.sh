#!/usr/bin/env bash
# milanote skill installer (macOS / Linux)
# Usage:  curl -fsSL https://raw.githubusercontent.com/RZX00/milanote-skill/main/install.sh | bash
set -euo pipefail

REPO="https://codeload.github.com/RZX00/milanote-skill/tar.gz/refs/heads/main"
SKILL_TARGETS=(
  "$HOME/.cursor/skills/milanote"
  "$HOME/.claude/skills/milanote"
  "$HOME/.codex/skills/milanote"
  "$HOME/.agents/skills/milanote"
)

if [ -n "${BASH_SOURCE:-}" ] && [ -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skills/milanote/SKILL.md" ]; then
  SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CLEANUP=""
else
  SRC="$(mktemp -d)"
  CLEANUP="$SRC"
  echo "Downloading milanote-skill..."
  curl -fsSL "$REPO" | tar -xz -C "$SRC" --strip-components=1
fi

cleanup() {
  if [ -n "$CLEANUP" ]; then
    rm -rf "$CLEANUP"
  fi
}
trap cleanup EXIT

if [ ! -f "$SRC/skills/milanote/SKILL.md" ] || [ ! -f "$SRC/opencli/clis/milanote/write.js" ]; then
  echo "milanote-skill: download did not include the skill and the OpenCLI adapter." >&2
  exit 1
fi

echo "Installing the milanote skill..."
for dir in "${SKILL_TARGETS[@]}"; do
  rm -rf "$dir"
  mkdir -p "$(dirname "$dir")"
  cp -R "$SRC/skills/milanote" "$dir"
  chmod +x "$dir/scripts/preflight.sh"
  echo "  skill -> $dir"
done

echo "Installing the OpenCLI adapter..."
mkdir -p "$HOME/.opencli/clis" "$HOME/.opencli/sites"
rm -rf "$HOME/.opencli/clis/milanote"
cp -R "$SRC/opencli/clis/milanote" "$HOME/.opencli/clis/milanote"
mkdir -p "$HOME/.opencli/sites/milanote"
cp "$SRC/opencli/sites/milanote/notes.md" "$HOME/.opencli/sites/milanote/notes.md"
echo "  adapter -> $HOME/.opencli/clis/milanote"

echo "Done. Install OpenCLI if you have not, sign in to Milanote in Chrome, then run: opencli milanote whoami -f yaml"
