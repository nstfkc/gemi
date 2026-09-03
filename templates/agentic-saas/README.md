# agentic-saas

A working support desk built on gemi's agent API — one agent, mounted on one
route, that looks up orders, runs diagnostics with the output streaming in as it
goes, asks the customer when it needs to, and stops dead to wait for a human
before it refunds anything.

It is a template, so the desk is fake and the API is real. There is no order
database and no payment processor behind these tools; every body returns canned
data, deliberately, so the first thing you meet when you run it is the agent
loop rather than a migration that did not seed. Swap the bodies for real work
and nothing above them changes.

Everything the API can do that is worth seeing is in here exactly once: a plain
tool, a generator tool that reports progress, an approval-gated tool, a question
answered by a person, a deferred namespace, a skill loaded from a markdown file,
and a sub-agent whose transcript renders inside the tool call that started it.

## Running it

```bash
bun install
cp .env.example .env
```

Then open `.env` and set two things:

- **`OPENAI_API_KEY`** — the agent will not start a run without it.
  `OPENAI_BASE_URL` is there if you point at a proxy, and the commented
  `AZURE_OPENAI_*` block is the alternative if you use `AzureOpenAIProvider`
  instead.
- **`SECRET`** — not decoration here. It is the key that signs a pending
  approval, and the signature is what stops a client answering "yes" to a
  refund the server never proposed, or raising `amountCents` on the way back.
  Left at the placeholder, anyone who can read this repo can forge one:

  ```bash
  openssl rand -base64 32 | head -c 32
  ```

Then create the database and start the dev server:

```bash
bunx prisma migrate deploy
bun dev
```

`http://localhost:5173` is the marketing page; `/chat` is the agent, behind the
`auth` middleware. Sign up, sign in, and you land on it.

The database is SQLite at `prisma/dev.db` and holds nothing but the auth tables.
Conversations live in a `MemoryAgentStore` — see below.

## A tour of `app/agents/`

Read these in this order. Each file is there to show one thing.

### `tools.ts` — the four shapes a tool comes in

**`lookupOrders` and `orderDetail` are the ordinary case**: an input schema, an
output schema, an `async` function. The schemas are built with `s`, gemi's
schema builder, and they do double duty — they generate the JSON Schema the
model is shown, and they type `part.input` and `part.output` in the browser. A
`.describe()` on a field is the only prose the model gets about it, so it is
worth writing.

`orderDetail` throws on an unknown id. That is not an exception out of the run:
gemi records it as a failed tool result the model reads and recovers from, which
is why the message is addressed to the model and names the tool that produces
real ids.

**`runDiagnostics` is an async generator**, and that is the entire difference.
Each `yield` is emitted as a `tool-progress` event and lands on the call part's
`progress` while the tool is still running, so a twenty-second tool does not
look like a hung page. The type rides along: `progress` is `{ line: string }[]`
for this tool because that is what this body yields. The inverse is the half
worth knowing before you design a UI — a tool whose `execute` returns a promise
cannot yield, so its progress type is `never[]` and a component that tries to
render progress for `orderDetail` does not compile.

**`issueRefund` sets `requiresApproval: true`**, so the server refuses to run it
until a person says so. The stream ends `awaiting-input`, the client gets a
pending call carrying a token signed over the run id, the tool name and the
exact input the server saw, and `approve(toolCallId, true)` sends it back. The
client can refuse — that is the point of asking — but it cannot edit the input
and still produce a signature that verifies, and the nonce in the token is spent
on use, so a replayed approval is rejected rather than paying twice.

**`askTool` is `AgentTool.ask`**, a tool with no `execute` at all: the answer
comes from the person, not the server. It suspends the run exactly the way an
approval does, which is why there is no second endpoint for it and why `useChat`
hands you approvals and questions through one `pending` list. Use it only for
what cannot be looked up — a question costs a round trip through a human who is
already waiting.

### `billing.ts` — a deferred namespace

`ToolNamespace.create({ deferred: true, tools })` groups three billing tools the
model searches rather than reads. The prompt carries the namespace description
and a line per tool; the parameter schemas are withheld until the model asks for
one. That is what keeps a long tail of rarely-used tools from costing anything
on the turns that never touch them, and most support turns are about a parcel,
not about proration.

It is a claim about the prompt and nothing else. It does not change who runs
these tools or what they return, and what the model has pulled in so far is on
`loadedTools` from `useChat` — somewhere to put "…finding the right tool"
instead of an unexplained pause. That list is run-scoped, not transcript-scoped:
it is empty again on the next run, so do not persist it beside `messages`.

### `skills.ts` and `app/skills/refund-policy.md` — instructions fetched, not handed

A `Skill` is a document the model goes and gets. Pasting the refund policy into
the agent's `instructions` would work and would be worse every month, because it
would cost its full length on every request including the overwhelming majority
that are about where a parcel is. As a skill it is lowered to a zero-parameter
tool, and the body arrives only on a turn where a refund is actually on the
table.

`instructions` is a thunk, so the file is read on first load rather than at
startup. The `description` is the load-bearing part — it is all the model has
when deciding whether to open the document, so it names the situations the
document settles.

### `research.ts` — a sub-agent, and the one thing that will surprise you

`researchAgent` is an ordinary `Agent.create`. Nothing makes it a sub-agent
except that `researchTool` runs it through `ctx.runAgent`, and the run it
produces is written to the parent call's `nested` — an ordinary `AgentMessage[]`
with a label, so the component that renders the transcript renders this too.

The comment in that file is the one to read twice. **If the sub-agent asks the
customer something, the tool body is re-entered from the top on the turn that
answers**, because a JS async generator cannot suspend across a turn boundary.
Everything above the `runAgent` runs twice. `ctx.resumed` is how a body tells
the second pass from the first; the alternatives are to put side effects after
the call or to make them idempotent. Get this wrong and you write the audit row
twice, and only for the conversations where the agent happened to ask.

If you want a sub-agent that can never escalate, pass `onPending: "deny"` to
`runAgent`. It is inherited all the way down, so a grandchild cannot ask either
— which is the only way "nothing from this subtree reaches the user" is a
promise worth making.

### `support.ts` — the agent, its store and its controller

`supportAgent` lists all of the above in `tools` and `skills`. `maxSteps: 12`
caps the tool-calling loop, `reasoning: "medium"` sets the effort, and
`maxDepth: 2` is how deep `ctx.runAgent` may go — read from the agent at the
root and carried down, so a sub-agent cannot deepen a tree it did not start.

`SupportAgentController` binds the agent to a route. `instructions(req)` is the
per-request half of the prompt, which is why it lives on the controller rather
than on `Agent.create` — this is the object that has the request. `onMessage`
and `onAwaitingInput` are where an app persists a turn and where it notifies an
approver who is not the person watching the stream; a hook that throws is
reported and the run carries on, so pointing them at a database that may be
having a bad day will not cost a customer the answer they are already reading.

## The two things you will get wrong first

Everyone hits both of these. They are not subtle bugs, but neither of them fails
in a way that says what happened.

### 1. `gemi/ai` is the server. `gemi/ai/client` is the browser.

A view or a component imports **only** from `gemi/ai/client`:

```tsx
import { useChat } from "gemi/ai/client";
import type { AgentMessage, PendingToolCall } from "gemi/ai/client";
```

Server code — everything under `app/agents/` — imports `s`, `Agent`,
`AgentTool`, `Skill`, `ToolNamespace`, `OpenAIProvider`, `AgentController` and
`MemoryAgentStore` from `gemi/ai`.

The split is not stylistic. A barrel is evaluated, not browsed: importing
`useChat` from `gemi/ai` would evaluate that entry, and that entry reaches the
providers (which read `OPENAI_API_KEY` out of the environment), the tool
registry (which closes over every `execute` in this repo, with its database
handles and secrets in scope) and the signing module (which reads `SECRET`).
Tree-shaking is not a defence to rely on for that — it is an optimization a dev
server, a test runner and a misconfigured build all skip, and the failure is
silent. The import graph is the defence, and it only holds if you stay on the
client entry.

Nothing is lost by doing so. `useChat` gets the agent's tool names, inputs and
outputs fully typed, because those travel as *types* on the route's `RPC` entry
rather than as a value the client has to import.

### 2. A thread id comes from the store, through your own route.

`this.agent(SupportAgentController)` mounts four paths under one key — the turn
itself, `/attach`, `/stop` and `/files` — and `useChat("/support")` finds all of
them from that one key. What it deliberately does **not** mount is a way to
create a thread, because minting one is where an app records who owns it and the
store has no idea who is asking. So `app/http/routes/api.ts` has:

```ts
"/support/threads": this.post(async () => {
  const user = await Auth.user();
  return supportStore.createThread({ userId: user.id });
}).middleware("auth"),
```

An id the client invents is a `thread_not_found` on turn one. Call this route
first, then hand the result to the hook:

```tsx
const { messages, sendMessage, status, pending, approve, answer } = useChat("/support", {
  threadId,
});
```

Omit `threadId` entirely and the hook keeps history itself and sends it with
every request — the stateless default, which is fine until you want a
conversation to survive a refresh.

The other half of the same rule is the one in `support.ts`: **`supportStore` is
a module-scope singleton, not a class field.** A controller is constructed fresh
for every request, so a store built in a field is a brand-new empty store on
every turn — `createThread` hands out an id the next request has never heard of,
and the history reads back as nothing. That failure is silent, because an empty
conversation is a legal one: the second turn simply forgets the first.

`MemoryAgentStore` lasts as long as the process, which is what a template wants
and not what a deployment with more than one server wants. Implement
`AgentStore` over your database and assign it the same way.

## Styling

This template is **Tailwind CSS 4**. The entire theme is `app/views/main.css` —
`@import "tailwindcss"`, a `@custom-variant dark`, `:root` and `.dark` blocks
holding raw oklch values, and an `@theme inline` block mapping them to
`--color-background` and friends. There is no `tailwind.config.js`, and adding
one will not do what you expect: in v4, configuration is CSS.

The components are **shadcn/ui "new-york", v4 conventions** — `data-slot`
attributes on roots, `size-4` rather than `h-4 w-4`, `tw-animate-css` in place
of `tailwindcss-animate`. They are vendored into
`app/views/components/ui/`, and `components.json` is real, so:

```bash
bunx shadcn@latest add popover
```

lands the component in the right place with the right import aliases. `cn()` is
at `app/views/components/lib/utils.ts`.

## Where everything lives

```
app/
  agents/           the agent, its tools, its skill, its sub-agent
  skills/           markdown a Skill loads on demand
  http/routes/      api.ts mounts the agent; view.ts mounts the pages
  views/
    Chat.tsx        the transcript, and everything useChat returns
    components/chat/  the parts of it: messages, tool calls, approvals
    components/ui/    shadcn primitives
    main.css        the whole theme
  config/           auth, database, middleware, queue, redis, route, schedule
  models/           Prisma-generated model classes
prisma/             schema + the initial migration
```

`app/config/auth.ts` sends a successful sign-in to `/chat`, and
`app/views/RootLayout.tsx` is the `<html>` shell every page renders inside.
