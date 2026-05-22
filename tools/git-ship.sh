#!/usr/bin/env bash
# git-ship.sh — Stage, commit, and push in one command.
# Shows context (status, diff, recent commits) before committing so you
# don't need to run those manually.
#
# Usage:
#   git-ship.sh "commit message" [file1 file2 ...]
#   git-ship.sh "commit message"          # stage all modified + untracked
#   git-ship.sh --dry-run "commit message" [files...]

set -euo pipefail

DRY_RUN=false

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
  shift
fi

MSG="${1:-}"
shift 2>/dev/null || true
FILES=("$@")

if [ -z "$MSG" ]; then
  echo "Usage: git-ship.sh [--dry-run] \"commit message\" [file1 file2 ...]"
  exit 1
fi

# ── Context ──────────────────────────────────────────────────────────────────
echo "═══ Recent commits ═══"
git log --oneline -5
echo ""

echo "═══ Working tree ═══"
git status --short
echo ""

echo "═══ Diff summary ═══"
if [ ${#FILES[@]} -gt 0 ]; then
  git diff --stat -- "${FILES[@]}" 2>/dev/null || true
  git diff --cached --stat -- "${FILES[@]}" 2>/dev/null || true
else
  git diff --stat 2>/dev/null || true
fi
echo ""

# ── Dry run ──────────────────────────────────────────────────────────────────
if $DRY_RUN; then
  echo "[DRY RUN] Would stage and commit with message:"
  echo "  $MSG"
  if [ ${#FILES[@]} -gt 0 ]; then
    echo "  Files: ${FILES[*]}"
  else
    echo "  Files: all modified + untracked"
  fi
  exit 0
fi

# ── Stage ────────────────────────────────────────────────────────────────────
if [ ${#FILES[@]} -gt 0 ]; then
  git add -- "${FILES[@]}"
else
  git add -A
fi

# ── Commit ───────────────────────────────────────────────────────────────────
git commit -m "$(cat <<EOF
$MSG

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"

# ── Push ─────────────────────────────────────────────────────────────────────
BRANCH=$(git branch --show-current)
echo "  Pushing to origin/$BRANCH..."
git push origin "$BRANCH"

echo ""
echo "✅ Shipped."
