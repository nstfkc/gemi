#!/usr/bin/env sh
#
# The runbook in `README.md` § The runbook, made executable.
#
# **Why this is a file rather than a paragraph.** The check has always been one
# command, and nothing invoked it — so the pooling failure the plan documents
# recurred three times *while the plan documenting it was being written*: #55
# merged seventeen seconds before its own base, #260 and #264 were stacked on a
# branch that had already merged and had no open PR, and `1fae1ea` sat on two
# branches for five days behind a closed issue saying it had shipped. Every one
# of those is visible to the loop below in under a second.
#
# It reports and does not delete. Deleting a remote branch is not reversible
# from here, and the list this prints is long enough that it should be read by
# a person before it is run.
#
#   sh plans/orm/branch-audit.sh                 # audit against origin/main
#   sh plans/orm/branch-audit.sh origin/next     # against some other trunk
#
# Exit status is 0 when no branch holds unresolved work, 1 when one does — so
# it can be a gate later without being rewritten. It is deliberately **not**
# wired into `.github/workflows/ci.yml` yet: it reports non-zero today, and a
# check that lands red is a check nobody reads afterwards. See #268.

set -eu

TRUNK="${1:-origin/main}"

git rev-parse --verify --quiet "$TRUNK" >/dev/null || {
	echo "no such ref: $TRUNK — fetch first, or name another trunk" >&2
	exit 2
}

printf 'trunk %s at %s\n\n' "$TRUNK" "$(git rev-parse --short "$TRUNK")"

# `feat/orm` itself is excluded: it is the integration branch the rest of these
# fed, not one of them, and it is kept for the history it names.
#
# `|| true` because a `grep` that matches nothing exits 1, and under `set -eu`
# that ends the script here — so a clone where the branches have already been
# deleted, which is the state this whole exercise is trying to reach, would
# abort instead of reporting that there is nothing left to do.
branches=$(
	git for-each-ref --format='%(refname:short)' refs/remotes/origin |
		grep -E '^origin/(feat|fix|tests|docs|ci)/orm' |
		grep -v '^origin/feat/orm$' || true
)

# An empty result is two different states and they must not print the same
# thing. "Every ORM branch has been deleted" is the success this exercise is
# aiming at; "this clone holds no remote-tracking refs to speak of" is a broken
# invocation, and it is the likely one wherever this runs as a gate —
# `actions/checkout@v4` fetches a single ref by default, which would make the
# check vacuously green forever. That is a worse failure than the red check this
# file deliberately does not land yet, so the two are separated by how many refs
# `origin` has at all, and the broken one exits 2 like the missing-trunk guard
# rather than 0.
n_origin=$(git for-each-ref --format='%(refname:short)' refs/remotes/origin |
	grep -cv '^origin/HEAD$' || true)

if [ -z "$branches" ]; then
	if [ "$n_origin" -le 1 ]; then
		echo "refs/remotes/origin holds $n_origin branch(es) — nothing was fetched to audit." >&2
		echo "Run 'git fetch origin' (a single-ref or shallow checkout is not enough)." >&2
		exit 2
	fi
	printf 'no ORM-named branches among %d on origin — nothing to audit.\n' "$n_origin"
	exit 0
fi

# The subjects on the trunk, read once rather than once per candidate commit.
trunk_subjects=$(mktemp)
trap 'rm -f "$trunk_subjects"' EXIT HUP INT TERM
git log "$TRUNK" --format='%s' >"$trunk_subjects"

deletable=''
superseded=''
holds=''
n_deletable=0
n_superseded=0
n_holds=0

for branch in $branches; do
	# Non-merge only. What a stacked branch holds that the trunk does not is
	# usually nothing but the merge commits its own child PRs created, and
	# counting those is what makes the first number read as one job per level
	# when it is one job in total.
	unique=$(git rev-list --no-merges --count "$TRUNK..$branch")

	if [ "$unique" -eq 0 ]; then
		deletable="$deletable $branch"
		n_deletable=$((n_deletable + 1))
		continue
	fi

	# A commit count cannot see a rebase, and this repository lands work by
	# rebasing often enough that the distinction decides the answer:
	# `feat/orm-json-filters` holds `1fae1ea`, whose content is on the trunk as
	# `cc22399` — #299's rebase of it, differing by a `docs/llms-full.txt` hunk
	# and one line, which is enough for `git cherry` to call it unmerged and
	# for the plain count to report 1 forever. Subjects survive a rebase where
	# patch-ids do not, so the subject is what is matched.
	#
	# It is a heuristic, and it decides rather than advises: a branch in this
	# bucket is not counted as holding work, so it is what makes the exit status
	# 0, and it is concatenated into the printed `git push origin --delete` line
	# below. A false hit therefore proposes a live branch for deletion, which is
	# why the match is exact and not merely close.
	#
	# `--grep` would be the obvious spelling and is the wrong one: it searches
	# the whole message, subject *and* body, for a *substring*. `--grep="0.51.0-rc.1"`
	# matches `0.51.0-rc.12` and `Bump version from 0.51.0-rc.1 to 0.51.0-rc.2`;
	# `--grep="JSON path filters"` also matches `9c8f3ef`, whose subject contains
	# no such text. Short subjects are common enough in this history for that to
	# be a real class and not a contrived one. `grep -Fxq` compares whole lines,
	# which is what "the same subject" means.
	#
	# What is left is the genuine heuristic the output labels: two unrelated
	# commits can share an identical subject.
	carried=1
	for sha in $(git rev-list --no-merges "$TRUNK..$branch"); do
		subject=$(git log -1 --format='%s' "$sha")
		if ! grep -Fxq -e "$subject" "$trunk_subjects"; then
			carried=0
			break
		fi
	done

	if [ "$carried" -eq 1 ]; then
		superseded="$superseded $branch"
		n_superseded=$((n_superseded + 1))
	else
		holds="$holds $branch($unique)"
		n_holds=$((n_holds + 1))
	fi
done

if [ -n "$holds" ]; then
	echo 'HOLDS UNRESOLVED WORK — decide these before deleting anything:'
	for b in $holds; do echo "  $b"; done
	echo
fi

if [ -n "$superseded" ]; then
	echo 'SUPERSEDED — the commits are not on the trunk, the content is (exact subject'
	echo 'match), so these are proposed for deletion alongside the empty ones:'
	for b in $superseded; do echo "  $b"; done
	echo
fi

printf '%s: %d deletable, %d superseded, %d holding unresolved work\n' \
	"$TRUNK" "$n_deletable" "$n_superseded" "$n_holds"

if [ "$n_holds" -eq 0 ] && [ -n "$deletable$superseded" ]; then
	echo
	echo 'Nothing is unresolved. To delete, re-run this and pipe the list rather'
	echo 'than trusting a copy of it — the set changes as branches land:'
	echo
	# shellcheck disable=SC2086
	printf '  git push origin --delete%s\n' "$(printf ' %s' $deletable $superseded | sed 's| origin/| |g')"
fi

[ "$n_holds" -eq 0 ]
