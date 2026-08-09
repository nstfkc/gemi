# Finalize ORM

## Goal
Release gemi@0.51.0

## Validation
ORM change PRs all pass in folio's repo
#740, #741, ..., #750

## Tasks

- [x] Check all issues with "orm" label in gemi's repo except #269, if there are more than one issue start a workflow that each agent takes an issue and validates if they are still valid and not implemented already creates a PR and saves the session otherwise closes the issue with a comment and adds a note to the notes section in this file
- [x] Start a workflow to check all the PR's related with orm and review them, and post the review comments 
- [x] Start a workflow to address the PR comments, each agent picks up from the session that originally created the PR
- [] Wait all PRs in gemi's repo to pass the checks merge them. Merge conflicts and fix issues if they raises. Then release another rc
- [] Bump the gemi version in all orm related PRs in folio' repo
- [] Start a workflow that each agent checks the orm related PR's in folio's repo if they are passing the checks, if e2e tests fail due to bun's segmentation error restarts the job and checks again. If there is a problem that needs to be fixed upstream files an issue in gemi's repo and leave the PR failed so it will be fixed in the next cycle. If there is a problem with the branch itself fixes the problems and updates the PR.


## Prompt
Take the next unchecked task from the tasks, if there are no unchecked tasks start from the first one. Update this file and mark the task you finished. This workflow requires to work on two projects both available locally. gemi is located at ~/projects/gemi and folio is located at ~/projects/folio. Their respective github repositories are https://github.com/nstfkc/gemi and https://github.com/Quantus-Labs/folioai.com. Do not ask questions to me, decide yourself and update the decision log section in this file. While you are working on your task mind the decision log and notes section. After you finish your task update the notes section if you think its good to notify the next agent.

## Decision log

### Cycle 1 — Task 1 (issue triage)

- **12 issues in scope**: #376, #374, #373, #372, #371, #369, #366, #301, #271, #268, #267, #263.
  #269 is excluded by the task description. One agent per issue, one phase.
- **"Saves the session" is a written handoff file, not a resumable agent.** Workflow subagents
  cannot be resumed by a later workflow, so Task 3's "each agent picks up from the session that
  originally created the PR" is implemented as an artifact: every agent writes
  `.orm-sessions/issue-<N>.md` in the **main checkout** (absolute path, deliberately outside its
  own worktree) covering claim vs. finding, root cause, files touched, tests run, what it could
  not verify, and rejected alternatives. Task 3's agents read that file instead of a transcript.
  `.orm-sessions/` is in `.git/info/exclude`, so it never dirties `git status` and imposes no
  tracked-file decision on the repo.
- **Worktree isolation per agent.** 12 agents cutting branches and opening PRs in one checkout
  would race on the index. Each is warned about the
  `templates/saas-starter/node_modules/gemi` symlink trap — in a worktree it resolves to the main
  checkout, so the template suite (where every live-DB and differential test lives) silently
  exercises unchanged code — and told to `bun install` in-tree and confirm with `readlink -f`
  before trusting a template result.
- **A third outcome beyond the task's two.** Task 1 names only "PR" or "close". Several of these
  are tracking or decision issues (#268 land-the-stack, #267, #301) that are neither
  implementable nor moot, so agents may return `left-open` with reasoning rather than being
  forced into a wrong close. Where PR-vs-close was genuinely close, agents were told to prefer
  the PR: a wrong close is silent, a PR is reviewable.
- No open PRs existed in gemi at cycle start, so Task 2 will review whatever this cycle produces.
- **Outcome: 12/12 agents, no errors — 10 PRs (#377–#386), 2 issues closed (#267, #263), none
  left open.** The `left-open` escape hatch went unused: every tracking issue turned out to have
  something concrete to land. Every PR has a session file at `.orm-sessions/issue-<N>.md`.

### Cycle 1 — Task 2 (PR review)

- **Scope: the 10 PRs this batch produced** (#377–#386). "All the PRs related with orm" is exactly
  that set — no other PRs were open in gemi at cycle start.
- **Reviews are posted as `COMMENT`, never `REQUEST_CHANGES`.** Task 4 merges this batch; a
  REQUEST_CHANGES review would block its own pipeline. Severity is carried in words instead —
  each finding is labelled **blocking**, **should fix**, or **nit**, and the summary opens with a
  one-line verdict. Approvals are also withheld: nothing here should self-approve.
- **Reviewers are given the author's session file.** `.orm-sessions/issue-<N>.md` records what the
  author could *not* verify and which alternatives it rejected. Those are the highest-value leads
  in a review, and a cold reviewer would never find them. This is the first payoff of writing the
  sessions in Task 1.
- **Inline comments, not just a summary.** Task 3 has to act on these, and a finding anchored to a
  file and line is actionable where a paragraph is not. Posted via
  `gh api repos/nstfkc/gemi/pulls/<N>/reviews --input` so summary and inline comments land as one
  review. Reviewers are told to demote a comment to the summary rather than lose the whole review
  if the API rejects a line that is not in the diff.
- **Reviewers must mutation-check the central test** by reverting the fix and re-running. A test
  that passes against unfixed code is the failure mode that matters here, and it is invisible to
  reading alone.
- **An 11th agent reviews the batch as a batch.** Per-PR reviewers each see one diff, and this
  repo's worst historical failure was a *semantic* merge conflict — `feat/orm` stopped typechecking
  for six merges because #92 and #102 never touched the same file (that history is why `ci.yml`
  runs on integration branches at all). The cross-PR agent checks the known #378/#379
  `planForeignSide` coupling, confirms the #386 migration ordering constraint, and returns a
  recommended merge order for Task 4.
- Reviewers are explicitly told **not to fix** what they find — Task 3 owns that, from the author's
  session.
- **Outcome: 11/11 agents, no errors.** All 10 reviews posted (`COMMENTED`), 44 inline comments,
  CI green on all 10. Verdicts: 8 minor-comments, 2 needs-changes (#378, #385). The cross-PR agent
  posted on the 6 PRs with findings and stayed silent on the 4 that were clean.
- **The cross-PR agent paid for itself twice.** It found a blocking conflict (#380 × #385) that no
  per-PR reviewer could see, and it *disproved* a claim I had written into Notes from a Task 1
  agent's report (the #386 regeneration hazard). Both are recorded below. Keep this agent in any
  future review cycle — the value is entirely in what a single-diff reviewer structurally cannot
  see.

### Cycle 1 — Task 3 (address review comments)

- **"Picks up from the session that originally created the PR" is honoured by reading
  `.orm-sessions/issue-<N>.md` first, before the review comments.** The ordering is deliberate:
  several findings are things the author already considered and declined, and an agent that reads
  the criticism before its own reasoning will silently reverse a decision it made for a good
  reason. This is the payoff the session files were written for in Task 1.
- **Agents may decline a comment.** A reviewer can be wrong — Task 2 produced one measured example
  where an *issue's* own reasoning was wrong (#371), so a review's can be too. Declining requires
  stating the evidence. The instruction cuts both ways: don't cave to a mistaken reviewer, and
  don't defend a real defect because you wrote it. Every comment gets a reply on GitHub either way,
  so the disposition of each point is visible without reading the diff.
- **A third disposition, `deferred`**, for findings whose fix belongs to another PR or to merge
  time. The `childField` → `childFields` rename from #386 is the clear case: #386 is not on `main`,
  so no other branch can reference the new names. Agents are told explicitly not to reach into
  another PR's branch — cross-PR fixes are assigned by the comment (#378 owns the hit-branch
  short-circuit, #385 owns respelling its numeric path segments).
- **Fixing the closing keyword is folded in here rather than left to Task 4.** #381 and #386 carry
  it in the title only; every agent verifies its own with
  `gh pr view <N> --json closingIssuesReferences`. Doing it at merge time means doing it under
  pressure, and this repo has four issues that stayed open for weeks from exactly this miss.
- **Mutation checks are re-run after the changes**, not assumed to survive them, and agents are
  told not to weaken a failing test to make it pass.
- **An 11th agent re-integrates the batch afterwards.** The first cross-PR pass ran *before* these
  fixes, so its conclusions are now stale by construction: the three blocking conflicts may be
  resolved, still open, or replaced by new ones the fixes introduced. It rebuilds the ten-PR
  integration branch and reports whether the batch is actually ready for Task 4 — which is the one
  question Task 4 needs answered and cannot cheaply answer itself.
- **Outcome: 11/11 agents, no errors.** 44 comments, 44 replied to, 0 declined, 6 deferred (all the
  #386 rename, correctly held for merge time). All ten PRs pushed a fix commit and all ten now
  carry a working closing keyword. The re-check verified the whole batch green on every suite
  including live Postgres.
- **Letting authors decline was the right call even though nobody used it.** #377 came closest:
  the reviewer's preferred fix (switch the docblock example to the one-to-one `Profile.user`) is
  not available in this package — `fixtures.ts`'s `profile.userId` is `nullable: false`, so
  `assertDisconnectable` refuses that disconnect outright. The agent measured that, kept the
  reviewer's *finding*, and rejected the reviewer's *remedy*. A workflow that only permitted
  "address" would have produced a wrong fix that still looked compliant.

### Cycle 1 — Task 4 (merge and release)

- **Not a workflow.** The task says merge, resolve conflicts, then cut an rc — a strictly ordered
  sequence over one shared `main`, where every step's input is the previous step's output. Fanning
  it out would put ten agents in a race for the same branch. Done sequentially in the main checkout,
  in the measured merge order.

## Notes

### From cycle 1, Task 1 — read before touching these PRs

**Issue → PR map.** #374→#377, #373→#378, #372→#379, #371→#380, #369→#381, #376→#382, #366→#383,
#268→#384, #301→#385, #271→#386. #267 and #263 were closed, not fixed.

**Two issues were only clerically open.** #267 and #263 were both already fixed on `main`
(cc22399 and 5f959ff, via PR #299), but #299 based on `next`, so its closing keywords never fired.
**#269 and #262 are open for the same reason** — #299 claims to close them too. Whoever revisits
#269 (excluded from this cycle by the task) should check whether it is live at all before
treating it as work.

**~~#386 changes the template schema and will break every other orm PR on rebase.~~ CORRECTED —
this was overstated.** Task 2's cross-PR agent measured it false for this batch: only #386 touches
`templates/saas-starter/prisma/` or `app/models/generated/` (all ten diffed), and #386's committed
artifacts reproduce byte-for-byte — after merging all ten, both `prisma generate`s plus
`differential-schema.ts` left `git status` clean. The test in question also lives at
`packages/gemi/orm/app-dependencies.test.ts`, not in the template. #386 should still merge **last**,
but for a different reason: its `childField` → `childFields` rename has to be absorbed by #378 and
#379, and going last means one rebase by the author who owns the composite helpers instead of two
by authors who don't.

**#372 and #373 are coupled.** #379 (#372) adds an `alreadyLinked` short-circuit beside
`clearLinks`; #378 (#373) is a one-line marker fix. #378's new pin compares `connectOrCreate`'s
outcome against `connect`'s rather than against a literal, so it stays green when #379 makes both
succeed — but review them together, and expect `connectOrCreate`'s hit branch to want the same
short-circuit via the `found[childField]` it already reads.

**Two real defects were found but deliberately not fixed** — they belong to no issue yet and are
candidates for the next cycle's Task 1:
- `redactFolded` tells a folded (lateral/Postgres) child it is a `findFirst` where a batched child
  is told `findMany` — measured, same query, same rows (found while fixing #366).
- `NestedUpdate<one>` in `orm/types.ts` offers `upsert` and `delete`, which `planOwningSide`
  refuses at runtime. `RelationInfo` records `kind` but not which side holds the foreign key, so
  the type cannot currently tell an owning to-one from a foreign one (found while fixing #369).

**#268 is only half-landed by design.** The landing half is genuinely done (`feat/orm`,
`feat/database-layer`, the container refactor and `next` are all ancestors of `main`). #384 fixes
the stale plan doc and adds `plans/orm/branch-audit.sh`; **deleting the 123 stale ORM branches and
wiring the audit into CI were left to a human deliberately** — do not let a later agent do this
unasked.

**Test-harness traps, paid for once already.** In a fresh worktree the template's differential
suites need `bun run build:bin` (from `packages/gemi/`), a `gemi-orm-generator` symlink, and *two*
`prisma generate` runs before they execute at all. `templates/saas-starter/node_modules/gemi`
resolves to the **main** checkout unless you `bun install` in-tree — verify with `readlink -f`.
Run suites as `bun --bun vitest run`; `defaults.test.ts` failing under `bun test` is pre-existing
noise. And `perl -0pi` patterns anchored on `] as const;` silently eat a tuple's last element —
use Edit.

**One issue's own reasoning was wrong.** #371 claimed gemi's refusal of `{ path, equals: null }`
was nonsense; Prisma 6.19.2 in fact answers it (extracts with `#>`, compares as jsonb, returns the
JSON-null rows). #380 therefore words it as a named divergence, not a bug fix. Treat issue text as
a claim to verify, not as a spec.

### From cycle 1, Task 2 — required reading for Task 3 and Task 4

**Merge order (from the cross-PR agent, measured on a real ten-PR integration branch):**

> **#377 → #380 → #381 → #382 → #383 → #384 → #385 → #379 → #378 → #386**

#377/#382/#383/#384 interact with nothing — landing them first shrinks what must be re-verified
after each later resolution. #380 precedes #381 and #385 because both must absorb its narrowing.
#379 precedes #378 adjacently because #378's pin is an equality *against #379's behaviour*. #386
last, per the corrected reason above.

**Three blocking cross-PR conflicts. Two merge cleanly and still break — this is the `#92`/`#102`
class the CI docblock was written about.**

1. **#378 × #379** — *the coupling Task 1 predicted would survive, and it does not.* Textual add/add
   in `nested-write-policies.test.ts` (both open `class KeyScoped`, both seed `Cover` 56), and after
   resolving, `expect(paired).toBe(bare)` fails: `bare` = `"resolved"`, `paired` =
   `"RecordNotFoundError"`. #379 short-circuits only the bare `connect`; `connectOrCreate`'s hit
   branch still clear-then-repoints. Fix is a three-line short-circuit on the hit branch using the
   `found[childField]` it already reads — measured green.
2. **#386 × #378 and #386 × #379** — clean `git merge`, does not compile. #386 renames
   `childField`/`parentField` → `childFields`/`parentFields`; #378 and #379 add new references to
   the old names in hunks #386 never touches. TS2552: 2 errors for #379+#386, 1 for #378+#386, 3
   for all ten. #379's `alreadyLinked` needs real generalisation — `sameKey` stays scalar-only
   under #386.
3. **#380 × #385 — nobody knew about this one.** Disjoint files, silent merge, two test failures.
   #380's `assertPathShape` refuses non-string path segments; #385 ships `["a", 0]` in `corpus.ts`,
   `plan-key.invariants.test.ts`, and a new `plan.ts` docblock that cites it as measured evidence.
   #380 also *widens* #385's own blocking finding: more shapes refused cold, same warm-key bypass.

**One resolution hazard that will pass CI-by-typecheck and fail loudly later.** #380 × #381 conflict
in `types.ts`, and the *natural* resolution — take #381's mapped type, which is its whole point —
silently reverts #380's `array_contains?: Exclude<JsonValue, null>`. Typecheck and the full 3123-test
package suite are green with the narrowing gone. Only the template's `test:types` catches it, as an
unused `@ts-expect-error`. CI does run it (`ci.yml` line 215).

**Two PRs will not close their issue when merged.** #381 and #386 carry the closing keyword in the
PR *title* only, so `closingIssuesReferences` is empty. This is the exact clerical failure that left
#267, #263, #269 and #262 open after PR #299. **Check every PR in the batch before merging** and fix
the body, or Task 4 will reproduce the bug this cycle just spent two agents cleaning up.

**Test-infrastructure facts worth not rediscovering:**
- `packages/gemi`'s own tsconfig has **`strictNullChecks` off**, so type-exactness assertions written
  there cannot tell `V` from `V | null`. Write them in `templates/saas-starter` via `bun run test:types`.
- `architecture.test.ts`'s export scan **misses `export type`** — which is why nothing committed in
  #381 fails when its change is reverted.
- `nested-write-policies.test.ts` builds its own `sqlite://` workspace, so the **Postgres CI job does
  not exercise it** — #379's three new tests included.
- `canonicalShape` drops `undefined` members, so `{path:["a"]}` and `{path:["a"], equals: undefined}`
  were already one plan-cache key while compiling to two different things. #380 closes that
  collision; no other PR touches it.

**Still-unfiled defects, now three.** The `redactFolded` divergence (a folded Postgres child is
redacted as `findFirst` where a batched child gets `findMany`) has no issue number, and #383 *widens*
it — the parent now reports `delete` while a folded child reports `findFirst`. Plus `NestedUpdate<one>`
offering `upsert`/`delete` that `planOwningSide` refuses, and #386's new one: two composite relations
sharing a foreign-key column now compile, and gemi's dedupe picks the alphabetically-last relation
where Prisma picks the caller's last `data` key (measured divergence). File these before merging so
the review notes have numbers to point at.

### From cycle 1, Task 3 — MERGE INSTRUCTIONS, read before Task 4 touches anything

The batch was re-integrated after the review fixes and is **green on every suite including live
Postgres** (3199 package / 848 template sqlite / 118 test:types / 1251 postgres / typecheck / oxlint).
All ten closing keywords verified correct. **Merge order is unchanged and measured:**

> **#377 → #380 → #381 → #382 → #383 → #384 → #385 → #379 → #378 → #386**

**Three merge-time edits are REQUIRED.** They are verified fixes, not diagnoses — without them the
batch does not compile and does not pass. Apply each at the merge named:

1. **At #378** — rename its differential case `M15e` → **`M15f`**. #378 and #379 both add a case
   labelled `M15e` to the same `CASES` array in `writes.differential.test.ts`. Git keeps both, both
   run, **both pass** — nothing catches it, but `vitest -t M15e` then selects two cases and #379's
   prose cross-references (`nested-write-policies.test.ts:1118`, `nested-writes.ts:2298`) become
   ambiguous.
2. **At #385** — add `/A JSON path is an array of strings, and path\[\d+\] is null/` to
   `EXPECTED_REFUSALS.postgres`, and correct the stale comment at `corpus.ts:167-173`. **The
   spelling matters**: the broad `/A JSON path is an array of strings/` also passes, but it masks
   #385's own numeric tripwire — verified, the broad form stays green when `["a","0"]` is reverted
   to `["a",0]`, the narrow form fails as it should.
3. **At #386** — absorb **five** `childField`/`parentField` → `childFields`/`parentFields` sites
   (was three; #378's review round added two). Four are pure renames. The fifth is not:
   `alreadyLinked` needs a real signature change to `fields: readonly string[]` /
   `values: readonly unknown[]` with `fields.every((f, i) => sameKey(named[f], values[i]))`, because
   `sameKey` stays scalar-only under #386. Keep the `every`.

**Two textual conflicts, both benign:** #381 in `types.ts` + `filters.test-d.ts`, and #378 in
`nested-write-policies.test.ts`. The latter is now a clean **keep-both** — #378 and #379's
`class KeyScoped` tests describe different scenarios (`{folderId: 2}` vs `{folderId: {in: [2,3]}}`)
and all four coexist. The other eight PRs apply clean.

**Both original blocking conflicts are gone.** #378 × #379 is resolved at the root, not patched:
#378 rebuilt its fixture so both spellings perform a real repoint, which also exposed that its
original pin was **vacuous** — under `scope: {folderId: 2}` the only visible cover already pointed
at folder 2, so the marked `update` never ran. #380 × #381's narrowing now survives the natural
resolution because #381 moved `Exclude<JsonValue, null>` onto the mapped type's arm.

**What the re-check could not measure:** that a *different* merge order gives the same result — the
order above is the one built and measured. And `nested-write-policies.test.ts` builds its own
`sqlite://` workspace, so the Postgres CI job still never exercises the #378/#379 coupling tests.
Pre-existing, unchanged by this batch.
