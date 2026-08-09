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
	# It is a heuristic, and the output labels it as one. Two unrelated commits
	# can share a subject, so this narrows the list a person reads rather than
	# deciding anything on its own.
	carried=1
	for sha in $(git rev-list --no-merges "$TRUNK..$branch"); do
		subject=$(git log -1 --format='%s' "$sha")
		if [ -z "$(git log "$TRUNK" --format='%h' --fixed-strings --grep="$subject" --max-count=1)" ]; then
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
	echo 'SUPERSEDED — the commits are not on the trunk, the content is (matched by subject):'
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
