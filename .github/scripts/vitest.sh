#!/usr/bin/env bash
# Runs `vitest run <args>` under Bun and fails unless Vitest actually ran tests.
#
# **Why this exists (#815).** #780 added `packages/gemi/vitest/`, and from then
# on `bun --bun vitest run …` in that package resolved `vitest` to the local
# directory, ran `vitest/index.ts`, printed nothing and exited 0. Every package
# test step in CI passed in 0 seconds for a day and nobody noticed, because a
# green step that ran nothing looks exactly like a green step that ran
# everything.
#
# So the runner is called as `bun --bun x vitest`, which resolves the package's
# bin and cannot be shadowed by a file or directory of the same name, and the
# step is only green when Vitest printed its summary with at least one passing
# test. Anything else — no output, no summary, `0 passed`, a summary from some
# other tool — is a failure with a message saying which.
#
# Usage, from the directory the suite runs in:
#   bash "$GITHUB_WORKSPACE/.github/scripts/vitest.sh" [vitest run args…]
#
# `VITEST_MIN_PASSED` raises the floor above 1 for a step that knows roughly
# how many tests it should run.
set -uo pipefail

min_passed="${VITEST_MIN_PASSED:-1}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

bun --bun x vitest run "$@" 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

# Colour codes stripped, so the match does not depend on FORCE_COLOR.
summary="$(perl -pe 's/\e\[[0-9;]*m//g' "$log" | grep -E '^[[:space:]]*Tests[[:space:]]+[0-9]' | tail -n 1)"
if [ -z "$summary" ]; then
  echo "::error::vitest exited 0 without printing a test summary, so it did not run (see #815)."
  exit 1
fi

passed="$(printf '%s\n' "$summary" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || true)"
if [ -z "$passed" ] || [ "$passed" -lt "$min_passed" ]; then
  echo "::error::vitest passed ${passed:-0} tests, expected at least $min_passed: $summary"
  exit 1
fi

echo "vitest guard: $summary"
