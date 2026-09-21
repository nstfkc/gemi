# Client conformance corpus

The Swift and Kotlin chat clients replay these files instead of keeping test
suites of their own. Every call `reducer.test.ts` and `sse.test.ts` make is
recorded here with what it returned (see `../conformance.ts`), so a native port
has passed exactly when it gives the TypeScript answer to every case.

Regenerate after a deliberate change to the reducer, the decoder or their tests:

```sh
cd packages/gemi
GEMI_UPDATE_FIXTURES=1 bun --bun vitest run ai/client
```

A normal run fails if the files are stale, so a behaviour change cannot reach
the native clients unannounced.

Both files are `{ "version": 1, "source": "<test file>", "cases": [...] }`, one
case per line. `test` on each case is the `describe > test` name that made the
call first — identical calls are kept once — and is only there to name a
failure.

## `reducer.json`

| `op`               | inputs                                   | expect                                 |
| ------------------ | ---------------------------------------- | -------------------------------------- |
| `initialChatState` | `init` (absent: no argument)             | `result`                               |
| `applyFrame`       | `state`, `frame`, `now`                  | `result`, and `unchanged`              |
| `markAborted`      | `state`                                  | `result`                               |

`state` and `result` are a whole `ChatState` as JSON. `unchanged` is true when
the TypeScript reducer returned its input object — the frame was a replay and
the hook fires no callbacks for it — so a port must report the same thing.

## `sse.json`

Each case is one decoder, fed `calls` in order. A call is either
`{ "push": { "text": "…" } | { "bytes": "<base64>" }, "frames", "cursor" }` or
`{ "flush": true, "frames", "cursor" }`: `frames` is what that call returned and
`cursor` is the decoder's cursor after it. Byte chunks may end halfway through
a UTF-8 character; that is what they are testing.

## Comparing

Compare JSON values, not text. A member the TypeScript side left `undefined` is
absent from the file, so a port's `nil`/`null` must encode as absent too. Key
order does not matter; array order does.
