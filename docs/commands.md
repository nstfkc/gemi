# Commands

Commands are one-off pieces of application code you run by hand: a seeder, a backfill, a tenant repair, a report. You define each one as a `defineCommand(...)` chain (from `gemi/services`) in a file under `app/commands/`, and run it with `gemi run <name>`. The command runs inside your booted application, so it reaches models, facades, mail and everything else exactly as a request handler does.

```bash
gemi run backfill-avatars 2024-01-01 --dry-run
```

## Defining a command

A command needs a name and a handler. Everything between them is optional.

```typescript
// app/commands/BackfillAvatars.ts
import { defineCommand } from "gemi/services";
import { User } from "@/app/models/User";

export default defineCommand("backfill-avatars")
  .describe("Regenerate avatar URLs for users created before the CDN move")
  .arg("since", { required: true, description: "ISO date to backfill from" })
  .option("dryRun", {
    type: "boolean",
    description: "Print the plan, write nothing",
  })
  .option("limit", {
    type: "number",
    default: 500,
    description: "Stop after N users",
  })
  .handle(async ({ args, options, line }) => {
    const users = await User.findMany({
      where: { createdAt: { gte: args.since } },
      take: options.limit,
    });

    line(`${users.length} users to backfill`);
    if (options.dryRun) return;

    // ...do the work...
  });
```

That file is the whole registration — there is no list to add it to. **Registering commands**, below, covers how the directory is read and how to take registration over yourself.

`args.since` is a `string`, `options.limit` is a `number`, and `options.dryRun` is a `boolean` — inferred from the chain, with nothing written by hand.

### Why it is a chain and not a class

Every other extension point in gemi is a class: `Job`, `CronJob`, `Controller`, `Middleware`. A command is not, and the reason is that a class cannot type its own handler.

TypeScript does not contextually type an overriding method's parameters from the base-class method it overrides. So a class declaring its schema as statics gets nothing from it:

```typescript
// the shape this replaces — it does not type-check
class BackfillAvatars extends Command {
  static args = [{ name: "since", required: true }];

  async run(ctx) {} // implicit any — `ctx.args.since` is unchecked
}
```

The only way out of that is to restate the type by hand in every command, which is the ceremony the schema was supposed to remove — and which nothing enforces, so a wrong restatement compiles. A **function expression passed as an argument** _is_ contextually typed, which is why `.handle(fn)` is the shape.

`.handle()` returns a `Command` subclass, so nothing else changes: discovery finds it by walking the prototype chain, exactly as it finds a `Job` or a `CronJob`. You can subclass `Command` by hand if you need to, and you give up the typing when you do.

## Arguments — `.arg()`

Positional values, in the order they are declared and the order they are typed.

```typescript
.arg("tenant", { required: true })
.arg("environment", { default: "staging" })
.arg("extra", { variadic: true })
```

| Key           | Type      | Description                                                                                 |
| ------------- | --------- | ------------------------------------------------------------------------------------------- |
| `description` | `string`  | Shown in `--help`.                                                                          |
| `required`    | `boolean` | Omitting it is a usage error rather than an `undefined`. On a variadic, means at least one. |
| `default`     | `string`  | Supplied when the argument is absent.                                                       |
| `variadic`    | `boolean` | Collects every remaining positional. Must be declared last.                                 |

What each combination gives the handler:

| Declaration                                     | Type in `args`                        |
| ----------------------------------------------- | ------------------------------------- |
| `.arg("x")`                                     | `string \| undefined`                 |
| `.arg("x", { required: true })`                 | `string`                              |
| `.arg("x", { default: "…" })`                   | `string`                              |
| `.arg("x", { variadic: true })`                 | `string[]` — `[]` when it took none   |
| `.arg("x", { variadic: true, required: true })` | `string[]` — a usage error when empty |

Declarations that contradict themselves are refused where you wrote them rather than surfacing later as a confusing usage error:

- `required` with `default` — an argument that is supplied when absent cannot also be absent.
- Anything declared after a `variadic` one, which would collect everything and leave the next permanently empty.
- `variadic` with `default` — a variadic is an empty list when it takes nothing, so the default could never apply.

## Options — `.option()`

Flags. Declared in camelCase and typed on the command line in kebab-case, so `.option("dryRun", …)` is `--dry-run` for whoever runs it and `options.dryRun` in the handler.

```typescript
.option("dryRun", { type: "boolean" })
.option("limit", { type: "number", default: 500 })
.option("tag", { type: "string", alias: "t", required: true })
```

| Key           | Type                                | Description                                                          |
| ------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `type`        | `"boolean" \| "string" \| "number"` | Required. Decides how the value is parsed and what the handler sees. |
| `description` | `string`                            | Shown in `--help`.                                                   |
| `alias`       | `string`                            | A single character, without the dash: `-t`.                          |
| `default`     | matching `type`                     | Applied only when the flag is absent, never over a supplied value.   |
| `required`    | `boolean`                           | Omitting it is a usage error. Not available on booleans.             |

`type` is required rather than defaulting to `"string"` because a `--dry-run` declared without one would arrive as the empty string, and every `if (options.dryRun)` over it would be wrong in the one direction nobody tests.

A `number` option that is not a number is a usage error, not a `NaN` in your handler:

```
$ gemi run backfill-avatars 2024-01-01 --limit abc
Option --limit expects a number, but got "abc".
```

All the usual spellings work: `--limit 5`, `--limit=5`, `-l 5`, `-l5`, `-l=5`, and clustered flags like `-dl 5`. A boolean can be turned off with `--no-dry-run`. Everything after a bare `--` is positional, however it is spelled — the escape hatch for an argument that looks like a flag.

An option that takes a value will not swallow the next flag as that value:

```
$ gemi run notify --message --dry-run
Option --message needs a value, but the next token is "--dry-run", which is
another option. If that really is the value, write --message=--dry-run.
```

Without this, `--message --dry-run` would set the message to the literal `"--dry-run"` and leave `dryRun` false — the dry run executes for real, and nothing says so. Use `=` when a value really does begin with a dash. Negative numbers (`--limit -5`) and a bare `-` are values, not flags, and need no escaping.

## The handler

`.handle(fn)` receives one argument holding everything the command has.

| Member                 | Type                                        | Description                                                     |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `args`                 | inferred                                    | The positional arguments, by the names `.arg()` declared.       |
| `options`              | inferred                                    | The flags, by the names `.option()` declared.                   |
| `argv`                 | `readonly string[]`                         | Everything after the command name, unparsed.                    |
| `line(message?)`       | `(message?: string) => void`                | The command's answer, on **stdout**.                            |
| `error(message)`       | `(message: string) => void`                 | A diagnostic, on **stderr**. Does not end the command.          |
| `fail(message, code?)` | `(message: string, code?: number) => never` | Ends the command with a message and an exit code, and no stack. |

The `line`/`error` split is the one thing worth being deliberate about. A diagnostic printed to stdout is what breaks `TOTAL=$(gemi run count-users)` and what makes a CI grep match a progress line instead of the answer — and it stays invisible until somebody pipes the command somewhere.

There is no `info`, `success`, `warn`, table or progress bar. Colour is your application's business, and a console formatting library is a project rather than a feature.

### Exit codes

| The handler                  | Exit code                                                   |
| ---------------------------- | ----------------------------------------------------------- |
| returns nothing              | `0`                                                         |
| returns an integer `0`–`255` | that number                                                 |
| returns anything else        | `1`, and says the value was not an exit code                |
| calls `fail(message, code)`  | `code` (default `1`), with `message` on stderr and no stack |
| throws                       | `1`, with the stack                                         |

An exit status is one byte, and both ways of naming one go through the same check. Anything outside `0`–`255` is reported rather than coerced, because coercion here is silent and inverts the answer: `return users.length` after 300 backfilled users would exit `44`, and ``fail(`${bad.length} rows failed`, bad.length)`` with 256 bad rows would exit **`0`** — a failure the `&&` chain or CI step waiting on it reads as a success.

```typescript
export default defineCommand("verify-invoices").handle(
  async ({ line, fail }) => {
    const broken = await findBrokenInvoices();

    if (broken.length > 0) {
      fail(`${broken.length} invoices failed verification`, 2);
    }

    line("all invoices verified");
  },
);
```

## Running one — `gemi run`

```bash
gemi run                       # list every command, with its description
gemi run backfill-avatars      # run one
gemi run backfill-avatars --help
```

Everything after the name belongs to the command, including its flags — `gemi run send-digest --queue` forwards `--queue` untouched, and `gemi run send-digest --help` prints that command's usage rather than `gemi run`'s. A `--` is available for a genuinely hostile tail (`gemi run x -- --weird`) but is never required.

`--help` is offered in whichever spellings your command has left free: declare an option called `help` and `--help` is yours, declare a `-h` alias and `-h` is yours, and each is decided on its own — a `.option("host", { alias: "h" })` keeps the long `--help` it never claimed. The usage screen lists only the spellings that actually work.

An unrecognised name prints a suggestion and the list, and exits `1`:

```
$ gemi run db:sed
No command named `db:sed`. Did you mean `db:seed`?

Commands in app/commands:

  db:seed      Seed the development database
  send-digest  Send the weekly digest to every subscribed user
```

> **Gotcha:** `gemi run` starts a **fresh Bun process**, the same way `gemi dev` and `gemi start` do, registering `gemi/bun/preload` and your `app/preload.ts` before any application code loads. It has to: those preloads can only be installed at process start, and a command that touches a controller needs the first while your models generally need the second.
>
> One consequence is worth knowing. `NODE_ENV` is passed through rather than forced, so `gemi run backfill` inherits whatever the shell has and `NODE_ENV=production gemi run backfill` is how you run against production semantics. That works precisely because the mode is fixed at the child's own startup.

### What a command may reach

Running a command boots the application fully — both phases — so a handler resolves services exactly as a request handler does:

```typescript
import { defineCommand } from "gemi/services";
import { app } from "gemi/foundation";
import { MailManager } from "gemi/services";

export default defineCommand("send-digest").handle(async ({ line }) => {
  app(MailManager); // typed, no cast
  line("sent");
});
```

Resolve services _inside_ the handler rather than at the top of the file. A command module is imported by discovery before the container has finished booting, and a service captured at module load is captured from a container that is not ready.

> **Gotcha:** the cron scheduler does **not** start under `gemi run`. Booting the application is how a command reaches the container, and starting the schedule is a side effect of that which nobody asked for — a backfill that runs for four minutes would otherwise fire your whole cron schedule in a process no one is watching, and the `Bun.cron` handles would hold it open besides. Your jobs are still discovered and `app(Scheduler).jobs` still answers honestly; nothing is scheduled. `gemi run` sets `GEMI_NO_SCHEDULE=1` on the process it spawns, and that variable works anywhere — it is also how a deploy runs one cron dyno beside several web ones.

> **Gotcha:** the queue is in-process, so a command that calls `Job.dispatch(...)` and then returns may exit before the job runs. Do the work in the command, or wait for it yourself. See [Jobs & Queues](./jobs-and-queues.md).

## Registering commands — `app/commands/`

Commands are discovered. Every class under `app/commands` that extends `Command` — which is what a finished `defineCommand` chain produces — is available to `gemi run`, so writing the file is all it takes.

Unlike [cron jobs](./cron.md#registering-jobs--appcron) and [queued jobs](./jobs-and-queues.md), this directory is **not** read at boot. A command registry has one consumer — `gemi run` — and reading it during boot would import every file under `app/commands` into every dev server, every production start and every deployed process, for code no request will ever reach. The walk happens when you run a command, and nowhere else.

### The chain must reach `.handle()`

A `defineCommand` chain that never calls `.handle()` is a plain object rather than a class, so nothing would find it. That is refused by name rather than passed over:

```
app/commands/Backfill.ts exports a command builder that never called `.handle()`,
so there is no command to run. `.handle()` is what turns the chain into a command
```

Without that check the command would simply be missing from `gemi run`, with nothing raised — the author sees a listing holding every command except the one they just wrote.

### Two commands, one name

A name is how a command is run, so only one can hold it. Two claiming the same name is refused outright, naming both classes — unlike the queue and the scheduler, which keep the first and warn. Those have a server to keep booting; here there is no boot to protect and a person is waiting, and running the wrong one of two commands called `db:seed` is worse than running neither.

### What the walk costs

A class does not exist until its module has run, so **every `.ts`/`.tsx` file under `app/commands` is imported** when you run a command, and a file that _does something_ on import does it then. The walk skips what certainly is not a declaration: `.d.ts` files, tests, type tests and benchmarks by their filename suffix, dot-directories, `node_modules`, and anything under a directory carrying its own `package.json`. Nothing else is guessed at.

A file that cannot be imported at all fails naming itself, rather than being quietly left out.

### Listing them explicitly — `app/config/command.ts`

Declaring `commands` in the `command` config slice turns discovery off and uses your list verbatim. Reach for it when the commands live somewhere the walk cannot reach, when you want a deliberate subset, or when the deploy ships only the build output.

```typescript
// app/config/command.ts
import { defineCommandConfig } from "gemi/services";
import BackfillAvatars from "@/app/commands/BackfillAvatars";

export default defineCommandConfig({
  commands: [BackfillAvatars],
});
```

**A present `commands` wins, and `commands: []` is present.** An empty array means an application with no commands and is honoured as such; it does not mean "go and find some". Leaving the key out — or leaving the slice out entirely — is what asks for discovery.

The file is wired into the kernel by name:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import command from "../config/command";

export default class extends Kernel {
  config = { command /* , ...other slices */ };
}
```

| Config key | Field         | Type             | Default          | Description                                                        |
| ---------- | ------------- | ---------------- | ---------------- | ------------------------------------------------------------------ |
| `command`  | `commands`    | `CommandClass[]` | _discovered_     | The command classes. Omit to discover them from `commandsDir`.     |
| `command`  | `commandsDir` | `string`         | `"app/commands"` | Where to discover them. Relative to the project root, or absolute. |

> The slice is called `command`, not `console`, for a small and annoying reason: a file named `app/config/console.ts` arrives in your kernel as `import console from "../config/console"`, which shadows the global `console` for the rest of that module.

### Asking what an application has

`discoverCommands()` walks `app/commands` (or a directory you name) and returns the classes it finds, without an application around it:

```typescript
import { discoverCommands } from "gemi/services";

const commands = await discoverCommands();
```

It imports every file it walks, the same as `discoverJobs()` and `discoverCronJobs()`.

## Commands vs. cron jobs vs. queued jobs

Use a **command** for work a person starts, by hand, once. Use a [**cron job**](./cron.md) for time-based recurring work. Use a [**queued job**](./jobs-and-queues.md) for work a request triggers and does not want to wait for. They compose: a command often dispatches jobs, and a cron `callback` often does the same thing a command does on demand.

## Related

- [CLI](./cli.md) — `gemi run` and every other command.
- [Cron](./cron.md) — recurring scheduled work.
- [Jobs & Queues](./jobs-and-queues.md) — background work triggered on demand.
- [Project Structure](./project-structure.md) — the kernel, `app/config/*.ts`, and service providers.
