# AI Tool Output for the Model

A tool's result goes to two readers: the client renders it, and the model reads it on the next step. Sometimes they need different amounts. A query tool might return 1000 rows for a table in the UI, while the model only needs the row count and the first few rows to answer. With `toModel`, the client gets the whole output and the model gets a smaller projection of it.

```ts
import { AgentTool, s } from "gemi/ai";

export const runQuery = AgentTool.create({
  name: "runQuery",
  description: "Run a read-only SQL query",
  inputSchema: s.object({ sql: s.string() }),
  execute: async ({ sql }) => queries.run(sql, { limit: 1000 }), // { columns, rows }
  // What the model reads instead of the whole output.
  toModel: (output) => ({
    columns: output.columns,
    rowCount: output.rows.length,
    rows: output.rows.slice(0, 50),
    truncated: output.rows.length > 50,
  }),
});
```

## What happens

- **The client gets the whole output.** The `tool-result` frame, `useChat`, `onMessage` and the thread store all have `output` as `execute` returned it.
- **The model reads the projection.** It is stored on the result as `modelOutput`, and the request sends it instead of `output`. A string is sent as is, and any other value as JSON. Compaction summaries use it too.
- **Computed once.** `toModel` runs when the result is produced, synchronously, and the value is kept with the result (as JSON). Every later request sends the model the same text, so the prompt cache holds, and a stateless client posts it back with the rest of the history. Changing `toModel` later does not change results already stored.
- **Successful results only.** Errors, refusals and `running` background jobs are sent as before. When a background job settles, its output gets the projection as well.
- **A `toModel` that throws** is logged, and the model reads the whole output. `undefined` also means the model reads the whole output.
- **Server tools only.** A client tool (`answeredBy: "client"`) can't set it: the client's answer is what the model reads.

`modelOutput` travels to the client with the result, so keep anything there that the user must not see out of `output` as well.

## Related

- [AI Tools That End the Run](./ai-tool-ends-run.md): `endsRun`, ending the run after a successful call.
- [AI Background Jobs](./ai-background-jobs.md): results that settle later.
- [AI Context Window](./ai-context-window.md): bounding what a long thread sends.
