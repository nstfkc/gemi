# Overnight log — merge the ai stack + build `agentic-saas` template

Started 2026-09-03. User asleep; all decisions made autonomously.

## Task
1. Merge all 21 open PRs (the stacked `ai/*` chain into `feat/ai`, then `feat/ai` into `main`).
2. Create a new template `templates/agentic-saas` demonstrating the new agent API,
   on latest shadcn/ui + Tailwind CSS 4.
3. Use the Workflow tool for the build (user explicitly asked).

## Findings
- Stack is strictly linear: main <- feat/ai <- ai/1-schema <- ... <- ai/20-sse-keepalive.
  Verified every branch is a direct ancestor of the next (merge-base --is-ancestor).
- PR map (head -> base): 425 feat/ai->main, 426 ai/1->feat/ai, 427 ai/2->ai/1,
  428 ai/3, 429 ai/4, 430 ai/5, 431 ai/6, 433 ai/7, 434 ai/8, 435 ai/9, 436 ai/10,
  437 ai/11, 438 ai/12, 439 ai/13, 440 ai/14, 485 ai/15, 480 ai/16, 482 ai/17,
  481 ai/18, 484 ai/19, 483 ai/20.
- CI green on the stack tip (483) and on 425. `main` has NO branch protection.
- `delete_branch_on_merge` is false on the repo — good, matches my note that
  deleting a branch auto-closes the dependent PRs in a stack.

## Decisions
- D1: Merge TOP-DOWN (483 first, 426 last), not bottom-up. Merging a stacked PR
  advances its *base*; only top-down cascades the whole stack into `feat/ai`.
- D2: Never pass `--delete-branch` during the cascade (would auto-close the
  dependents below it, and they'd be unreopenable afterwards).

## Part 1: merging the stack — DONE

- D3: `gh pr merge --rebase` worked for the top 14 (#483..#433), then #431 was
  refused: "This pull request is part of a stack and must be merged using the
  asynchronous merge REST API." The repo has GitHub's stacked-PR feature on.
- D4: `PUT /repos/:owner/:repo/pulls/{n}/merge` also refuses stacked PRs (403).
  The correct endpoint is `PUT /repos/:owner/:repo/pulls/{n}/merge-async`
  (poll PR state afterwards; it is not synchronous). Used that for #431..#426.
- SURPRISE, and the important bit: GitHub's stack-aware merge does NOT just
  advance the immediate base. It rebased the whole stack **straight onto
  `main`**. `main` went b31c7f15 -> 8f1a00c4, +51 commits, linear, no merge
  commits. `feat/ai` and every `ai/*` branch were left behind at their old tips
  and are now stale leftovers — do not re-merge or force-push them.
- Consequence: PR #425 (feat/ai -> main) closed itself as MERGED without my
  ever merging it. All 21 PRs are MERGED; `gh pr list --state open` is empty.
- No branch was deleted at any point (per the stacked-PR note in memory).

## Part 2: the `agentic-saas` template

### Template facts gathered
- `templates/*` is a bun workspace; templates depend on `"gemi": "*"` (workspace link).
- `create-gemi-app` hardcodes `let template = "saas-starter"` and tars
  `gemi-main/templates/<template>/` off GitHub main. A second template needs the
  commented-out `prompts` select restored to be reachable.
- saas-starter is also the framework's integration test-bed (models/*.test.ts,
  bench/, generated-lists/, partial+suspense demos). None of that belongs in a
  focused agent example.
- saas-starter is Tailwind 3 (`tailwind.config.js` + `@tailwind` directives +
  `hsl(var(--x))` tokens, postcss w/ autoprefixer, tailwindcss-animate).

### Agent API surface (from packages/gemi/ai on main)
- Server entry `gemi/ai`: `s`, `Agent`, `AgentTool`, `Skill`, `ToolNamespace`,
  `PendingEscalation`, `OpenAIProvider`, `AzureOpenAIProvider`, `AgentController`,
  `MemoryAgentStore`, `defaultAgentStore`, `liveRuns`.
- Browser entry `gemi/ai/client`: `useChat` + the message vocabulary as types.
  The split is deliberate — importing `gemi/ai` from a view would pull the
  providers, the tool registry and `signing.ts` (reads SECRET) into the bundle.
- Route: `this.agent(Controller).middleware({stream,attach,stop,upload})` mounts
  four paths under one key. Thread ids must come from `store.createThread(...)`
  via the app's own route; a client-invented id is `thread_not_found`.
- Env: `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`), or the AZURE_* set.

### Decisions
- D5: New template built fresh at `templates/agentic-saas`, NOT a copy of
  saas-starter — reuse its config/auth/kernel shape only. Keeps the example
  readable, which is the whole point of a template.
- D6: Tailwind CSS 4 proper: `@import "tailwindcss"`, `@theme inline`, oklch
  tokens, `@custom-variant dark`, `@tailwindcss/postcss`. No tailwind.config.js.
- D7: shadcn "new-york" v4 style — `data-slot` attributes, `components.json`
  with an empty `tailwind.config`, `tw-animate-css` instead of
  `tailwindcss-animate`. Components vendored in (a template can't run `shadcn add`
  at build time).
- D8: The example app is a support-desk agent, because it exercises every part
  of the API worth showing: plain tools, a generator tool with progress, an
  approval-gated tool, `AgentTool.ask`, a deferred `ToolNamespace`, a `Skill`,
  and a sub-agent reached through `ctx.runAgent`.

### Scaffold (done by hand, before the workflow — deterministic work, no need to spend agents on it)
- Copied verbatim from saas-starter: tsconfig, vitest.config, .gitignore,
  .oxlintrc, .oxfmtrc, Dockerfile, public/, gemi.config.ts, client.tsx,
  server.ts, preload.ts, AppServiceProvider, config/{database,middleware,queue,
  redis,route,schedule}.ts, models/User.ts.
- Dropped config/{log,mail,filesystem,features,translation}.ts and rewrote
  Kernel.ts and auth.ts without them — a template that teaches the agent API
  should not also be carrying a Telegram log sink and a legacy i18n dictionary.
- prisma/schema.prisma pruned to the auth models the framework actually needs
  (User, Account, Session, PasswordResetToken, MagicLinkToken, SocialAccount,
  Organization, OrganizationInvitation, Membership, Profile + the plan enum).
  Dropped Post/Tag/Ledger*/FeatureFlag — those exist in saas-starter as ORM
  differential-test fixtures, not as anything an app starts from.
  `bunx prisma generate` regenerated app/models/generated cleanly, and
  `prisma migrate diff` produced prisma/migrations/0_init (10 tables).
- Wrote package.json (tailwindcss ^4.1.11 + @tailwindcss/postcss + tw-animate-css,
  no autoprefixer/tailwindcss-animate), postcss.config.js, components.json
  (v4 shape: `"config": ""`), .env.example (documents OPENAI_API_KEY and warns
  that SECRET is what approval signatures are minted with).

### create-gemi-app
- Restored the template select that was commented out, now listing saas-starter
  and agentic-saas, and wired up the `-t/--template` flag that was commented out
  beside it. Rejects an unknown template up front — the tar filter matches
  nothing for a path that does not exist, so the failure would otherwise be an
  empty project directory rather than an error.

### Workflow
- Run wf_d3caa861-b96. Phase 1: seven authors over disjoint file sets (theme,
  shadcn primitives, tools+skill, agent+controller, routers, chat UI, shell+README),
  coordinated by a frozen contract of route keys / tool names / exports written
  into the brief rather than discovered. Phase 2: three independent audits —
  cross-file contract wiring, the gemi/ai vs gemi/ai/client boundary, and
  Tailwind-3/shadcn-v3 leftovers.

## Part 3: what the workflow produced, and what I had to fix after it

Workflow wf_d3caa861-b96: 10 agents, 0 errors, ~893k subagent tokens, 22 min.
Two of the three audits came back clean (the gemi/ai-vs-gemi/ai/client boundary,
and the Tailwind-3/shadcn-v3 leftover sweep). The contract audit found four real
seams between the concurrent authors, all fixed:
1. `Chat.tsx` seeded its empty state with `cus_204`/`ord_1042`, which the canned
   table in `tools.ts` does not contain — so all three starter suggestions
   returned "no such order". Repointed at `cus_ada` / `ord_2001`.
2. A comment on `AppRouter` in `view.ts` claimed `middlewares = ["auth"]` also
   guarded the agent's four api paths. It does not — view and api routes flatten
   into separate tables. Rewrote it to say where the real guard is, since a
   comment that tells a reader an unguarded agent route is guarded is worse than
   no comment.
3. `refund-policy.md` cited `ord_1044`, an id nothing defines, inside a document
   that instructs the model never to quote an id it has not looked up.
4. `billing.ts` said `cus_grace` where `tools.ts` says `cus_gus` — one dataset
   written by two hands.

### Then I ran it, which found three things no audit did
- `bun run build` FAILED on `@import "tailwindcss"`: Vite resolves a
  stylesheet's `@import`s itself, before any PostCSS plugin runs, so
  `@tailwindcss/postcss` never saw it and the build tried to open a file called
  `tailwindcss`. Switched to `@tailwindcss/vite` in `gemi.config.ts` and deleted
  `postcss.config.js`. (I initially misread a background job's exit code as the
  build passing — it was the wrapper's. The build had failed.)
- `bun run start` died on boot: gemi's OWN auth router mounts two views the app
  must provide, `auth/MagicLinkSignIn` and `auth/OauthCallback`, and a third,
  `_Redirect`, is required by the redirect path. None are listed in the app's
  `view.ts`, so nothing in the source hints they are needed — the failure is
  "not found in server manifest" at boot. Written, with comments saying why the
  filenames are load-bearing.
- `@types/react` 19.0.2 against react 19.2.3 produced 41 TS2786 "cannot be used
  as a JSX component" errors. saas-starter carries the same pin and the same
  errors; since this template is new, I bumped it to ^19.2.0 instead of
  inheriting the problem. Template now typechecks at 0 errors.

### Verified working (prod build + running server on :5199)
- `/` 200, `/auth/sign-in` 200, `/auth/sign-up` 200, unknown path 404
- `/chat` 302 -> `/auth/sign-in` (view middleware)
- `/api/support`, `/support/threads`, `/support/attach`, `/support/stop` all 401
  unauthenticated — the four-paths-under-one-key mount and its middleware map
  are real, not just declared
- CSS is genuine Tailwind 4.3.3 output: 66 oklch values, no leftover @import
- The fake tools execute: lookupOrders/orderDetail return canned rows,
  runDiagnostics yields 3 progress lines then returns, issueRefund returns a receipt
- 0 tsc errors, 0 oxlint warnings, oxfmt clean (the only unformatted files are
  Prisma-generated, exactly as in saas-starter)

### NOT verified — needs a key
No live model call was made: there is no OPENAI_API_KEY in this environment. The
approval round-trip, the ask/answer turn, the deferred-namespace load and the
sub-agent nesting are all typechecked and wired, but nobody has watched them run.
That is the first thing to do with a key in `.env`.
