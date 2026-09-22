import { isApiPath } from "../services/router/apiPath";

// The production server's last resort: an error nothing on the way here turned
// into a response. Request breakers (auth, 404s, 416s) are answered by the
// dispatchers before this, so what arrives is a genuine failure — and its
// message and stack are for the developer, not for whoever triggered it. They
// can carry absolute paths, dependency versions, SQL fragments and column
// names. The dev server renders them on purpose (`httpDev.ts`); this does not.

const GENERIC_500_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Internal Server Error</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; }
      main { text-align: center; padding: 16px; }
      h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
      p { margin: 0; opacity: 0.7; }
    </style>
  </head>
  <body>
    <main>
      <h1>Something went wrong</h1>
      <p>Please try again later.</p>
    </main>
  </body>
</html>`;

export function unhandledErrorResponse(
  err: unknown,
  pathname: string,
  onException?: (error: Error) => void,
): Response {
  // `onException` is the report, and the default one `App` installs is a
  // `console.error`, so logging here as well printed every failure twice
  // (three times for `/api`, whose dispatcher logs before rethrowing). Only
  // without a reporter does this log itself.
  //
  // Reported for `/api` too: an app's error tracking should see an API failure
  // that got this far, not only a page one. `onRequestFail` is a different
  // hook (route config, called by the dispatchers), so this is not a second
  // report through the same channel.
  if (!onException) {
    console.error(err);
  } else {
    try {
      // The hook is typed to receive an `Error`; a thrown string or object is
      // wrapped so a reporter reading `.stack` or `.name` gets one.
      onException(err instanceof Error ? err : new Error(String(err), { cause: err }));
    } catch (reportError) {
      // A broken reporter must not turn a 500 into a leaked stack either.
      console.error(err);
      console.error(reportError);
    }
  }

  if (isApiPath(pathname)) {
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(GENERIC_500_HTML, {
    status: 500,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
