#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "--search" ]]; then
  shift
  exec codex --search exec --skip-git-repo-check "$@"
fi

if [[ "${1:-}" == "exec" ]]; then
  shift
  exec codex exec --skip-git-repo-check "$@"
fi

exec codex "$@"
