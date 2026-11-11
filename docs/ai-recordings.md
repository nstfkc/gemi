# AI Recordings

A test or an eval that calls a real model is slow, costs money, needs a key and answers differently from one run to the next. `RecordingProvider`, from `gemi/ai/testing`, records a live provider's calls once and replays them afterwards, with no model: the same answers every time, offline and in CI.

```typescript
import { Agent, type AgentProvider } from "gemi/ai";
import { pinClock, type Recording, RecordingProvider } from "gemi/ai/testing";

declare const live: AgentProvider;
const file = "evals/cases/welcome.recording.json";

const pagesAgent = (provider: AgentProvider) =>
  Agent.create({ name: "pages", provider, instructions: "You write welcome pages." });

export async function runCase(record: boolean) {
  const provider = record
    ? RecordingProvider.record(live)
    : RecordingProvider.replay((await Bun.file(file).json()) as Recording);

  const restore = record ? () => {} : pinClock(provider.recordedAt);
  try {
    const result = await pagesAgent(provider)
      .stream({ messages: [], turn: { text: "A welcome page" } })
      .result();
    if (record) await Bun.write(file, JSON.stringify(provider.recording(), null, 1));
    return { text: result.text, stale: [...provider.stale] };
  } finally {
    restore();
  }
}
```

- `RecordingProvider.record(live, options)` sends every call to `live` and keeps what it streamed. `recording()` answers it as plain JSON: write it wherever you like.
- `RecordingProvider.replay(recording, options)` answers each call with the recorded one, without a live provider.

It is an `AgentProvider`, so it goes wherever a provider goes: `Agent.create`, `agent.stream({ provider })`, `generate({ provider })`, an `Eval` task.

## What a replay matches

The n-th call of a replay is answered with the n-th recorded call, and it has to be the same request:

- **Messages** are compared by `role` and `content` only: their ids and times are minted per run. A tool call's sub-run transcript is left out (sub-runs are recorded on their own, see below), and so is the full output of a tool whose model reads a projection (`toModel`). A call resends the messages of the one before it, so a recording keeps only the new ones, and grows with the run rather than with its square.
- **Ids minted per run** (a record's id, a job's) differ between the recording and the replay. Each recorded id matches the id at its place in the request, the same one wherever it shows, across every call. The recorded answer is given the replay's ids, so a tool call the model makes names the record the replay made. Ids are UUIDs by default; set `ids` to another pattern.
- **Tools** are compared by a hash of the tool list.

## When a prompt changes: stale, not failed

A recording that throws as soon as a prompt changes has to be made again after every prompt edit, all of them at once. So a replayed request that differs from the recorded one can still replay, counted as **stale**: `provider.stale` lists why (`"app/agents/prompts/tone.md changed"`, `"tools changed: addCard"`), and `provider.staleCalls` how many calls were. Report those cases as stale, apart from passing and failing, and record them again when convenient. What may differ is set by `match`:

- `"wording"` (the default): the wording of the prompt files changed since the recording, and nothing else. The static text of each changed file (and of the partials it includes) is cut out of both requests, the recorded version's out of the recorded request and today's out of the replay's, so the messages, the tool calls and results and every value filled into the prompts must still be the same. It needs fingerprints, below.
- `"shape"`: anything but the shape of the conversation (its roles, tool calls with their inputs, tool results with their status): the instructions, settings and message text. For an app whose prompts aren't files.
- `"exact"`: nothing.

In `"wording"` and `"shape"`, the tools offered may differ too, as long as every tool call the recorded answer makes is to a tool still offered and fits its schema today. A schema part `s.fromJSONSchema` can't model (a free-form `props: {}`) isn't checked: the tool still validates its input when the call runs. Anything else throws a `RecordingMismatchError` that shows where the two requests first differ, ids aside: a different conversation has no recorded answer.

### Fingerprints

Record with `fingerprints` and the recording keeps what it was made with (`recording.fingerprints`):

- each prompt file whose text its requests carried, by path, as its git blob id, so the recorded version can be read back from git;
- each tool it offered, as the hashes of its definitions;
- `inputs`, any other hashes the app says it depends on, such as the schemas behind generated tools.

```typescript
import { createHash } from "node:crypto";
import type { AgentProvider } from "gemi/ai";
import { type Recording, RecordingProvider } from "gemi/ai/testing";

declare const live: AgentProvider;
declare const recording: Recording;
declare const componentSchemas: Record<string, unknown>;

const fingerprints = {
  root: process.cwd(),
  dirs: ["app/agents", "evals"],
  // The component schema behind each `add_<component>` tool offered.
  inputs: (tools: ReadonlySet<string>) =>
    Object.fromEntries(
      Object.entries(componentSchemas)
        .filter(([name]) => tools.has(`add_${name.toLowerCase()}`))
        .map(([name, schema]) => [
          name,
          createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
        ]),
    ),
};

export const recorder = () => RecordingProvider.record(live, { fingerprints });
export const replay = () => RecordingProvider.replay(recording, { fingerprints });

// Which recordings to make again, without running anything:
export const changed = () => RecordingProvider.changedSince(recording, fingerprints);
```

- `root` is the repository (git runs there), `dirs` the prompt folders under it (`["app/agents"]` by default, as `Prompt.render`), and `shared` the folder a bare partial name resolves in (`prompts`). `readBlob` replaces git for reading a recorded version back.
- A prompt file counts as sent when one of its three longest pieces of static text is in a request.
- `RecordingProvider.changedSince(recording, options)` names each prompt file and input changed since; a replay's `provider.fingerprints()` says what it sent, to compare with the recording's (`Fingerprints.same`).
- A recorded version that git no longer has can't be cut, so its calls throw: record them again.

## Sub-runs

A run whose tools start sub-runs (`ctx.runAgent`, or specialists of your own running side by side) records each sub-run apart: hand each one `provider.nested(key)`, under a key that names it the same way in every run.

```typescript
import { Agent, type AgentProvider } from "gemi/ai";
import type { RecordingProvider } from "gemi/ai/testing";

declare const provider: RecordingProvider;
const designer = (provider: AgentProvider) => Agent.create({ name: "designer", provider });

export async function design(section: string) {
  return designer(provider.nested(`designer:${section}`))
    .stream({ messages: [], turn: { text: `Design the ${section}` } })
    .result();
}
```

Each sub-run replays its own calls in its own order, so sub-runs running side by side replay in whatever interleaving they happen to run. A key the recording does not have throws.

When the order shows (which of two workers finishes first decides what the lead is told), `ordered: true` replays every call, the sub-runs' too, in the order they started when recorded.

When the runs change shared state as they go, `position` names a position in it that only moves forward, such as an edit log's head. Recording, each call keeps where it was when its answer had streamed; replaying, a call's answer waits until the app gets there again, so tool calls running side by side write in the recorded order. `await provider.pin(now)` does the same for a prompt rendered from that state: it answers the position the recorded call's prompt showed, once the app is there. A wait longer than `waitMs` (60 seconds) throws.

## Uploads

`upload(file)` answers `upload_1`, `upload_2`, … in order. A file need not be the same bytes on another machine for its call to replay. Recording, the file goes to the live provider too, and the calls show the model the provider's id.

## Time

`recordedAt` is when the recording started. A case whose prompts or tools depend on today (a sample record due "in three days", a "this week" list) replays the same only at that time. `pinClock(at)` runs `Date` from `at` and answers a function that puts the real clock back; time still passes at its real rate, and timers are not touched. It is process-wide, so don't run two pinned replays side by side. Inside vitest, `vi.setSystemTime(provider.recordedAt)` does the same.

## With `Eval`

An [`Eval`](./ai-evals.md) task can take the provider for each case and run, replaying in CI and recording on demand. Count a case with a non-empty `stale` as stale in your report, apart from pass and fail.
