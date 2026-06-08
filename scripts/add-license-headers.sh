#!/usr/bin/env bash
# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.
#
# Idempotently applies the standard 5-line agentObserve copyright header
# to every source file in this repo. Run from the repo root:
#
#   ./scripts/add-license-headers.sh           # apply
#   ./scripts/add-license-headers.sh --check   # exit 1 if any file lacks header
#   ./scripts/add-license-headers.sh --dry-run # show what would change
#
# Skips: docs (README/LICENSE/COPYRIGHT/NOTICE/CHANGELOG/CLAUDE/DESIGN/PRODUCT),
# generated artifacts (node_modules, .venv, dist, telemetry, data, .pids, .logs),
# lock files, and anything already carrying our header.

set -euo pipefail

MODE="apply"
case "${1:-}" in
  --check)   MODE="check" ;;
  --dry-run) MODE="dry-run" ;;
  "")        MODE="apply" ;;
  *) echo "usage: $0 [--check|--dry-run]"; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MARKER='Copyright (c) 2026 Rishu Goyal. All rights reserved.'

# Header bodies per comment syntax. Trailing blank line separates header from code.
HEADER_HASH=$(cat <<'EOF'
# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.

EOF
)

HEADER_SLASH=$(cat <<'EOF'
// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.

EOF
)

HEADER_CSS=$(cat <<'EOF'
/* Copyright (c) 2026 Rishu Goyal. All rights reserved.
 * Licensed under the Business Source License 1.1.
 * See LICENSE in the project root for license terms.
 */

EOF
)

# Files explicitly excluded by path. Docs already have the COPYRIGHT/LICENSE pair.
EXCLUDE_PATTERNS=(
  "./node_modules/*"
  "./.venv/*"
  "./.git/*"
  "./.pids/*"
  "./.logs/*"
  "./.claude/*"
  "./.agents/*"
  "./.impeccable/*"
  "./dist/*"
  "./telemetry/*"
  "./data/*"
  "./__pycache__/*"
  "./README.md"
  "./LICENSE"
  "./COPYRIGHT"
  "./NOTICE"
  "./CHANGELOG.md"
  "./CLAUDE.md"
  "./DESIGN.md"
  "./PRODUCT.md"
  "./VERSION"
  "./package-lock.json"
  "./uv.lock"
  "./skills-lock.json"
  "./index.html"
)

is_excluded() {
  local f="$1"
  for pat in "${EXCLUDE_PATTERNS[@]}"; do
    # shellcheck disable=SC2053
    [[ $f == $pat ]] && return 0
  done
  return 1
}

# Pick a header body for the file type. Returns the header in $HEADER, comment
# style in $STYLE (hash|slash|css), or non-zero if no rule matches.
pick_header() {
  local f="$1"
  case "$f" in
    *.py|*.sh|*.toml|*.yml|*.yaml|*Dockerfile|*.dockerfile)
      HEADER="$HEADER_HASH"; STYLE=hash; return 0 ;;
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx)
      HEADER="$HEADER_SLASH"; STYLE=slash; return 0 ;;
    *.css|*.scss)
      HEADER="$HEADER_CSS"; STYLE=css; return 0 ;;
  esac
  return 1
}

# True if file already contains the marker line in the first 10 lines.
has_header() {
  head -n 10 "$1" 2>/dev/null | grep -F -q "$MARKER"
}

# Insert header, preserving a leading shebang if present (line 1 starts with #!).
apply_header() {
  local f="$1" header="$2"
  local tmp
  tmp=$(mktemp)
  if head -n 1 "$f" | grep -q '^#!'; then
    {
      head -n 1 "$f"
      echo
      printf '%s\n' "$header"
      tail -n +2 "$f"
    } > "$tmp"
  else
    {
      printf '%s\n' "$header"
      cat "$f"
    } > "$tmp"
  fi
  mv "$tmp" "$f"
}

# Walk every tracked file under the repo root.
missing_count=0
applied_count=0
total_count=0

while IFS= read -r f; do
  is_excluded "$f" && continue
  pick_header "$f" || continue
  total_count=$((total_count + 1))
  if has_header "$f"; then
    continue
  fi
  case "$MODE" in
    check)
      echo "MISSING: $f"
      missing_count=$((missing_count + 1))
      ;;
    dry-run)
      echo "WOULD APPLY ($STYLE): $f"
      applied_count=$((applied_count + 1))
      ;;
    apply)
      apply_header "$f" "$HEADER"
      echo "APPLIED ($STYLE): $f"
      applied_count=$((applied_count + 1))
      ;;
  esac
done < <(find . \
  -type d \( \
       -name node_modules -o -name .git -o -name .venv -o -name dist \
    -o -name telemetry -o -name data -o -name __pycache__ \
    -o -name .pids -o -name .logs -o -name .claude -o -name .agents \
    -o -name .impeccable \
  \) -prune -o -type f -print)

case "$MODE" in
  check)
    if (( missing_count > 0 )); then
      echo "FAIL: $missing_count of $total_count source files missing header." >&2
      exit 1
    fi
    echo "OK: all $total_count source files carry the header."
    ;;
  dry-run)
    echo "DRY-RUN: would apply header to $applied_count of $total_count files."
    ;;
  apply)
    echo "DONE: applied header to $applied_count of $total_count files."
    ;;
esac
