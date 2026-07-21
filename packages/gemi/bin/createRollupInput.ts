import { Glob } from "bun";
import { join } from "node:path";

// The entry list for the Vite client + SSR builds (passed through as
// GEMI_INPUT). Derived straight from the filesystem — the same view set
// `app/client.tsx` registers via `import.meta.glob` — so the build no longer
// needs to boot the app kernel to discover views.
//
// Keep these patterns in sync with `app/client.tsx`'s `init()` glob:
//   include "./views/**/*.tsx"
//   exclude "./views/**/components/**", "./views/**/assets/**",
//           "./views/RootLayout.tsx"
export default async function (appDir: string): Promise<string[]> {
  const viewsDir = join(appDir, "views");
  const glob = new Glob("**/*.tsx");

  // `client.tsx` is always the client entry; RootLayout is bundled into it
  // directly (hence excluded from the view globs below).
  const entries = new Set<string>(["/app/client.tsx"]);

  for await (const file of glob.scan({ cwd: viewsDir })) {
    // `file` is POSIX-relative to `viewsDir`, e.g. "Home.tsx",
    // "dashboard/Index.tsx", "components/ui/sidebar.tsx".
    const segments = file.split("/");
    if (segments.includes("components")) continue; // **/components/**
    if (segments.includes("assets")) continue; // **/assets/**
    if (file === "RootLayout.tsx") continue; // ./views/RootLayout.tsx
    // Test files are not views — keep them out of the build so they never
    // become a Vite entry (and never emit a compiled chunk into `dist`).
    if (/\.(test|spec)\.tsx$/.test(file)) continue; // **/*.{test,spec}.tsx

    entries.add(`/app/views/${file}`);
  }

  return Array.from(entries);
}
