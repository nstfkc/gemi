import { Link } from "gemi/client";
import { CompassIcon } from "lucide-react";

// Rendered on its own rather than inside a layout — the client router swaps the
// whole view tree for `["404"]` — so this page paints its own background and
// fills the viewport itself.
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center text-foreground">
      <CompassIcon className="size-10 text-muted-foreground" />
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Nothing at this address</h1>
        <p className="max-w-md text-muted-foreground text-pretty">
          The page you asked for is not one this app serves. The support agent is still where you
          left it.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/chat"
          className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
        >
          Back to the chat
        </Link>
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-md border border-border px-5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Home
        </Link>
      </div>
    </div>
  );
}
