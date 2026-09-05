import { Link } from "gemi/client";
import { LifeBuoyIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/app/views/components/lib/utils";

function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2 font-semibold", className)}>
      <LifeBuoyIcon className="size-5 text-primary" />
      Helpdesk
    </Link>
  );
}

// Not `LayoutProps<"PublicLayout">`: this layout's handler returns nothing, and
// asking for the generated type would tie a marketing shell to `gemi.d.ts`
// having been written at least once — which it has not on a fresh clone.
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <nav className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <Wordmark />
          <div className="flex items-center gap-6 text-sm">
            <Link
              href="/auth/sign-in"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign in
            </Link>
            <Link
              href="/auth/sign-up"
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
            >
              Create an account
            </Link>
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl grow px-6 py-16">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <Wordmark className="text-foreground" />
          <p>A gemi template. The support desk behind it is entirely made up.</p>
        </div>
      </footer>
    </div>
  );
}
