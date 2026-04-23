#!/usr/bin/env bash
# restore-extensions.sh
#
# Wipes pi-sandbox/.pi/{extensions,child-tools}/* and restores from the
# pristine backup created by rebuild-deferred-writer.sh.
#
# Usage: scripts/restore-extensions.sh

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="$REPO/pi-sandbox"
BACKUP="$SANDBOX/.pi/scratch/backups/pristine"
EXT_DIR="$SANDBOX/.pi/extensions"
CHILD_DIR="$SANDBOX/.pi/child-tools"

if [[ ! -d "$BACKUP" ]]; then
  echo "No pristine backup at $BACKUP. Nothing to restore." >&2
  exit 1
fi

rm -rf "$EXT_DIR"/* "$CHILD_DIR"/* 2>/dev/null || true
cp -a "$BACKUP/extensions/." "$EXT_DIR/"
cp -a "$BACKUP/child-tools/." "$CHILD_DIR/"

echo "Restored from $BACKUP."
ls -la "$EXT_DIR" "$CHILD_DIR"
