/**
 * The error for a view gemi's own routes need that the app does not have
 * (#1040): it names the file and the config that turned the route on, rather
 * than leaving the module loader to report a path it could not resolve.
 */
export function missingRequiredViewError(view: string, requiredBy: string) {
  return new Error(
    `app/views/${view}.tsx is missing. gemi's auth routes render it because ${requiredBy} is on. ` +
      `Add the view, or turn that setting off in app/config/auth.ts.`,
  );
}
