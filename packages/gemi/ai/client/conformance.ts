import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, expect } from "vitest";
import { applyFrame, initialChatState, markAborted } from "./reducer";
import { SSEFrameDecoder } from "./sse";

/**
 * The conformance corpus the native clients are held to.
 *
 * The Swift and Kotlin ports of `reducer.ts` and `sse.ts` are rewrites, and a
 * rewrite of a reducer whose whole job is converging from any suffix of a run
 * is exactly where a subtle difference hides — one that shows up as doubled
 * text after a reconnect, on a phone, months later. So they do not get their
 * own test suites to drift from this one. They get *this one*: every call the
 * TypeScript tests make is recorded here with what it returned, and a native
 * suite replays each call and demands the same answer.
 *
 * Recorded from the tests rather than written beside them, so there is no
 * second list of scenarios to keep in step. A test added to `reducer.test.ts`
 * is in the corpus the next time the fixtures are updated, and a behaviour
 * change that forgets to update them fails here, in the TypeScript suite,
 * before any native client has been built.
 *
 * `GEMI_UPDATE_FIXTURES=1 bun run test ai/client` rewrites the files.
 */

const UPDATE = process.env.GEMI_UPDATE_FIXTURES === "1";

type Corpus<C> = { version: 1; source: string; cases: C[] };

/**
 * Checks the recorded corpus against the file, or writes it.
 *
 * A mismatch is a failure rather than a silent rewrite: the file is what the
 * native suites read, so it changing is a protocol change someone has to see.
 *
 * Only a complete run can be compared whole. `-t` or a `.only` records a
 * slice of the corpus, and demanding equality from a slice would fail every
 * filtered run for a reason that has nothing to do with the code. So a partial
 * run checks that what it did record is in the file — a behaviour change in
 * the tests that ran still fails — and refuses to write.
 */
function settle<C>(target: string, source: string, cases: C[], suite: Suite) {
  const complete = ranEverything(suite);
  // JSON.parse(JSON.stringify(...)) is the comparison the native side makes:
  // it drops `undefined` members, which a Swift optional or a Kotlin nullable
  // reads back as absent anyway.
  const recorded: C[] = JSON.parse(JSON.stringify(cases));
  const stale =
    `${target} is out of date. The native clients replay it, so a change ` +
    `here changes what they must do: rerun ${source} with GEMI_UPDATE_FIXTURES=1 and commit ` +
    `the diff.`;

  if (UPDATE) {
    if (!complete) {
      throw new Error(`GEMI_UPDATE_FIXTURES=1 needs every test in ${source} to run and pass.`);
    }
    // One case per line: pretty-printed, the whole states the reducer cases
    // carry made the file several times larger, and a line per case is what
    // a diff of an updated corpus should be read in anyway.
    const lines = recorded.map((entry) => JSON.stringify(entry)).join(",\n");
    writeFileSync(
      target,
      `{"version":1,"source":${JSON.stringify(source)},"cases":[\n${lines}\n]}\n`,
    );
    return;
  }

  if (!existsSync(target)) throw new Error(stale);
  const onDisk: Corpus<C> = JSON.parse(readFileSync(target, "utf8"));
  if (complete) {
    expect(recorded, stale).toEqual(onDisk.cases);
    return;
  }
  // Compared without the test name: a call is kept once, under the first test
  // that made it, so a filtered run can make the same call under another name.
  const unnamed = ({ test: _test, ...entry }: C & { test?: string }) => JSON.stringify(entry);
  const known = new Set(onDisk.cases.map(unnamed));
  const missing = recorded.filter((entry) => !known.has(unnamed(entry)));
  expect(missing, stale).toEqual([]);
}

// Vitest hands a file-level hook its fixtures first and the suite second.
type Suite = Parameters<Parameters<typeof afterAll>[0]>[1];

/** Every test in the file ran, and passed. A failing test's recording is the
 *  failure's, not the protocol's. */
function ranEverything(suite: Suite): boolean {
  return suite.tasks.every((task) =>
    task.type === "suite"
      ? ranEverything(task as Suite)
      : task.mode === "run" && task.result?.state === "pass",
  );
}

function currentTest() {
  // `describe > test`, the same name the failing native case prints.
  return expect.getState().currentTestName ?? "(outside a test)";
}

// --- the reducer ----------------------------------------------------------

type ReducerCase =
  | { test: string; op: "initialChatState"; init?: unknown; result: unknown }
  | {
      test: string;
      op: "applyFrame";
      state: unknown;
      frame: unknown;
      now: string;
      result: unknown;
      /** `applyFrame` returned its input. The hook reads that identity as
       *  "already applied" and skips its callbacks, so a port has to be able
       *  to say the same thing — as a flag, since it has no object identity
       *  to lean on. */
      unchanged: boolean;
    }
  | { test: string; op: "markAborted"; state: unknown; result: unknown };

/**
 * `applyFrame`, `markAborted` and `initialChatState`, recording as they run.
 *
 * Identical calls are kept once. The tests fold the same run from scratch many
 * times over, and a corpus of the same case repeated is only slower to replay.
 */
export function recordReducer(target: string) {
  const cases: ReducerCase[] = [];
  const seen = new Set<string>();
  const keep = (entry: ReducerCase, { test: _test, result: _result, ...inputs }: ReducerCase) => {
    const key = JSON.stringify(inputs);
    if (seen.has(key)) return;
    seen.add(key);
    cases.push(entry);
  };

  // Vitest parses a hook's first parameter as its fixtures and refuses one that
  // is not a destructuring pattern, so the empty one is load-bearing.
  // oxlint-disable-next-line no-empty-pattern
  afterAll(({}, suite) => settle(target, "ai/client/reducer.test.ts", cases, suite));

  return {
    applyFrame: ((state, frame, now) => {
      if (now === undefined) {
        // `createdAt` would be the wall clock, and a fixture that differs on
        // every run is not a fixture.
        throw new Error("Pass `now` to applyFrame in a recorded test.");
      }
      const snapshot = JSON.parse(JSON.stringify(state));
      const result = applyFrame(state, frame, now);
      const entry: ReducerCase = {
        test: currentTest(),
        op: "applyFrame",
        state: snapshot,
        frame,
        now,
        result: JSON.parse(JSON.stringify(result)),
        unchanged: result === state,
      };
      keep(entry, entry);
      return result;
    }) as typeof applyFrame,

    markAborted: ((state) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      const result = markAborted(state);
      const entry: ReducerCase = {
        test: currentTest(),
        op: "markAborted",
        state: snapshot,
        result: JSON.parse(JSON.stringify(result)),
      };
      keep(entry, entry);
      return result;
    }) as typeof markAborted,

    initialChatState: ((init) => {
      const result = initialChatState(init);
      const entry: ReducerCase = {
        test: currentTest(),
        op: "initialChatState",
        ...(init === undefined ? {} : { init: JSON.parse(JSON.stringify(init)) }),
        result: JSON.parse(JSON.stringify(result)),
      };
      keep(entry, entry);
      return result;
    }) as typeof initialChatState,
  };
}

// --- the SSE decoder ------------------------------------------------------

/** A chunk as `reader.read()` hands it over, or as a test does. Bytes are
 *  base64 because the interesting byte chunks end halfway through a UTF-8
 *  character, which no JSON string can hold. */
type Chunk = { text: string } | { bytes: string };

type DecoderCall =
  | { push: Chunk; frames: unknown[]; cursor: number }
  | { flush: true; frames: unknown[]; cursor: number };

type DecoderCase = { test: string; calls: DecoderCall[] };

/**
 * An `SSEFrameDecoder` that logs every push and flush with what came out and
 * where the cursor stood after, one case per decoder.
 */
export function recordDecoder(target: string): new () => SSEFrameDecoder {
  const cases: DecoderCase[] = [];

  // Vitest parses a hook's first parameter as its fixtures and refuses one that
  // is not a destructuring pattern, so the empty one is load-bearing.
  // oxlint-disable-next-line no-empty-pattern
  afterAll(({}, suite) => settle(target, "ai/client/sse.test.ts", cases, suite));

  return class RecordingDecoder extends SSEFrameDecoder {
    private calls: DecoderCall[] = [];

    constructor() {
      super();
      cases.push({ test: currentTest(), calls: this.calls });
    }

    override push(chunk: Uint8Array | string) {
      const frames = super.push(chunk);
      this.calls.push({
        push:
          typeof chunk === "string"
            ? { text: chunk }
            : { bytes: Buffer.from(chunk).toString("base64") },
        frames: JSON.parse(JSON.stringify(frames)),
        cursor: this.cursor,
      });
      return frames;
    }

    override flush() {
      const frames = super.flush();
      this.calls.push({
        flush: true,
        frames: JSON.parse(JSON.stringify(frames)),
        cursor: this.cursor,
      });
      return frames;
    }
  };
}
