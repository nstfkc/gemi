import type { ModelSchema } from "./schema";

/**
 * The one configuration where a `DateTime` read comes back as the wrong instant.
 *
 * `dialect/postgres.ts` records it as a KNOWN DIVERGENCE and `docs/orm.md` now
 * states the requirement — run Postgres deployments with `TZ=UTC`. Prisma maps
 * `DateTime` to `timestamp(3)`, and Bun decodes that column differently
 * depending on which wire protocol carried the statement, which in turn depends
 * on whether the query bound a parameter:
 *
 *     TZ=America/New_York   findMany()            -> 2021-03-04T10:06:07.008Z
 *                           where id = $1         -> 2021-03-04T05:06:07.008Z
 *
 * A reader who has seen the documentation sets `TZ=UTC` and never meets this. A
 * reader who has not gets two different instants for the same row and no signal
 * at all — the values look plausible, nothing raises, and the difference is
 * exactly the machine's UTC offset, which is the kind of wrongness that reaches
 * a report or an invoice before anyone notices.
 *
 * So this says it once. The project's stated trade, from the `Json` encoder that
 * had the same shape of bug, is that "a loud failure replaces a silent
 * mis-store"; a warning is the most that can be done here, because the value is
 * already decoded by the time anything in this package sees it and it does not
 * carry which protocol produced it.
 *
 * **Not gated on `NODE_ENV`, unlike the slow-transaction warning.** That one is
 * a performance hint, and a hint is worth having only where somebody is
 * watching. This is a correctness fault, and production is exactly where an
 * unnoticed wrong timestamp costs something. It fires once per process, and
 * only when every condition below holds, so a correctly configured deployment
 * never sees it.
 *
 * Pure, and returns the message rather than printing it, so the conditions can
 * be tested without capturing console output or depending on the machine's
 * clock — `offsetMinutes` is a parameter for exactly that reason.
 */
export function protocolSkewWarning(
  dialect: string,
  schema: ModelSchema,
  text: string,
  values: readonly unknown[],
  offsetMinutes: number,
): string | null {
  // Cheapest discriminators first: three of the four are a comparison, and the
  // field scan only runs for a parameterless Postgres select on a machine that
  // is not already UTC.
  if (dialect !== "postgres") return null;
  if (values.length > 0) return null;
  if (offsetMinutes === 0) return null;

  // A statement that binds nothing and returns no rows cannot show the skew.
  // `RETURNING` writes always bind at least the values they write, so in
  // practice this is the parameterless read.
  if (!/^\s*select/i.test(text)) return null;

  const columns = Object.values(schema.fields)
    .filter((field) => field.type === "DateTime")
    .map((field) => field.name);

  if (columns.length === 0) return null;

  return (
    `[gemi] ${schema.name} was read with a query that binds no parameters, on ` +
    `Postgres, in a process whose clock is not UTC. Bun decodes ` +
    `timestamp(3) over the simple query protocol as local time, so ` +
    `${columns.length === 1 ? "the column" : "columns"} ` +
    `${columns.join(", ")} will be off by this machine's UTC offset — the same ` +
    `row read through a query that binds a parameter returns a different ` +
    `instant. Set TZ=UTC on this process. See "Run Postgres deployments with ` +
    `TZ=UTC" in docs/orm.md. (Warned once.)`
  );
}
