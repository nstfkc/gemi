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

/**
 * A zone's UTC offset at one instant, asked of a *named* zone.
 *
 * `Date.prototype.getTimezoneOffset` can only answer for the ambient zone, so a
 * test — which runs under `TZ=UTC`, in CI and per the note above — cannot use
 * it to ask what `Europe/London` does in July. `Intl` can: formatting an
 * instant into a zone and reading the fields back as though they were UTC
 * recovers the offset, because the difference between the two *is* what the
 * zone added.
 *
 * With no zone it defers to the clock, which is the call site's path and avoids
 * making the process's own answer depend on `Intl` agreeing with `TZ`.
 */
function offsetMinutesAt(instant: number, timeZone?: string): number {
  if (timeZone === undefined) return new Date(instant).getTimezoneOffset();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));

  const at = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  const local = Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    at("hour"),
    at("minute"),
    at("second"),
  );

  // `getTimezoneOffset`'s sign convention — minutes to add to local time to get
  // UTC, so positive west of Greenwich — because that is what the caller and
  // `protocolSkewWarning` above both already speak.
  return (instant - local) / 60_000;
}

/**
 * Whether this process's clock can be off UTC **at any point in the year**.
 *
 * The call site reads this once, at module load, so that a correctly configured
 * deployment pays a boolean per query rather than a `Date` allocation. The
 * thing that may be cached for the life of a process is the *zone*, though, and
 * not the offset it happens to have today:
 *
 *     TZ=Europe/London     January  0     July  -60
 *     TZ=Europe/Lisbon     January  0     July  -60
 *     TZ=Africa/Accra      January  0     July    0     (genuinely fixed)
 *     TZ=UTC               January  0     July    0
 *
 * Reading `new Date().getTimezoneOffset()` once would put London in the same
 * bucket as UTC for any process started between late October and late March,
 * and switch the diagnostic off for the whole of BST — when the skew is real.
 * That is the wrong way round: the entire audience for this warning is
 * deployments that did not set `TZ=UTC`.
 *
 * So the question is asked of the zone, by probing a year of it. Twelve probes
 * rather than the two that separate the table above, because northern-summer
 * DST is not the only shape a transition comes in — `Africa/Casablanca` moves
 * with Ramadan, which walks through the calendar — and twelve `Date`s at module
 * load is a cost paid once, against a rule this has to get right for years.
 *
 * `timeZone` exists so the predicate is answerable from a UTC machine, which is
 * the same move that made `protocolSkewWarning` testable: the call site passes
 * nothing and gets the clock.
 */
export function clockCouldSkew(timeZone?: string): boolean {
  // The current year, so a zone that has since abolished its DST is read as it
  // is now rather than as some pinned year remembers it.
  const year = new Date().getUTCFullYear();

  for (let month = 0; month < 12; month++) {
    if (offsetMinutesAt(Date.UTC(year, month, 1), timeZone) !== 0) return true;
  }

  return false;
}

/** Reports the skew at most once, and only while it is still possible. */
export type ProtocolSkewWarner = (
  dialect: string,
  schema: ModelSchema,
  text: string,
  values: readonly unknown[],
) => string | null;

/**
 * The call site's half of the warning: the gate, the once-per-process latch,
 * and nothing else.
 *
 * It lives here rather than as two module-level bindings in `Model.ts` because
 * of what CI can see. `Model.ts` needs a database to exercise, and the one
 * configuration CI runs — `TZ=UTC` — is the configuration where *neither*
 * branch of the gate can produce a warning. So a gate written inline is
 * invisible to the suite in both directions: inverting it, or deleting the line
 * that sets the latch, leaves every test green. Behind this seam both are
 * ordinary assertions, with no database and no dependence on the ambient clock.
 *
 * `offsetMinutes` is a function, and read per call rather than captured,
 * because caching it is the same mistake `clockCouldSkew` exists to avoid one
 * level up: a London process that cached a winter `0` would clear the gate and
 * then be silenced by `protocolSkewWarning`'s own `offsetMinutes === 0` test
 * all summer. Only a process that could skew ever reads the clock, and it stops
 * as soon as it has said so — which is exactly the deployment the cost is worth
 * paying for.
 */
export function createProtocolSkewWarner(
  couldSkew: boolean,
  offsetMinutes: () => number,
): ProtocolSkewWarner {
  let warned = false;

  return (dialect, schema, text, values) => {
    if (!couldSkew || warned) return null;

    const warning = protocolSkewWarning(
      dialect,
      schema,
      text,
      values,
      offsetMinutes(),
    );

    // Latched on firing, not on asking: the first statement of a process is
    // rarely the parameterless read, and a query that could not have shown the
    // skew is no evidence that none will.
    if (warning !== null) warned = true;

    return warning;
  };
}
