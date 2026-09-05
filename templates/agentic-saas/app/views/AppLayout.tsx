import type { ReactNode } from "react";
import { Link, useLocation, useNavigate, useSignOut, useUser } from "gemi/client";
import { LogOutIcon, MessagesSquareIcon, SparklesIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "@/app/views/components/ui/avatar";
import { Button } from "@/app/views/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/views/components/ui/dropdown-menu";
import { Separator } from "@/app/views/components/ui/separator";
import { cn } from "@/app/views/components/lib/utils";

// `as const` so `href` stays the literal route rather than widening to
// `string`, which is what `Link` needs to type the target it points at.
const NAV = [{ href: "/chat", label: "Support desk", icon: MessagesSquareIcon }] as const;

/**
 * The shell every signed-in page renders inside.
 *
 * It fixes the viewport height and hides the overflow, which is not decoration:
 * the chat scrolls its own transcript, and a shell that grows with its child
 * would push the composer below the fold and leave two scrollbars racing each
 * other. Everything under here is expected to lay itself out inside a column
 * that is already the right height.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { user } = useUser();
  const { replace } = useNavigate();
  const { trigger: signOut, loading } = useSignOut({
    onSuccess: () => {
      void replace("/auth/sign-in");
    },
  });

  const name = user?.name ?? user?.email ?? "Signed in";

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <aside className="flex w-14 shrink-0 flex-col border-r bg-muted/30 md:w-60">
        <div className="flex h-14 items-center gap-2 px-3 md:px-4">
          <SparklesIcon className="size-5 shrink-0" />
          <span className="hidden truncate text-sm font-semibold md:inline">Acme Support</span>
        </div>
        <Separator />

        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground data-[pending=true]:opacity-50",
                pathname === item.href
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground",
              )}
            >
              <item.icon className="size-4 shrink-0" />
              <span className="hidden md:inline">{item.label}</span>
            </Link>
          ))}
        </nav>

        <Separator />
        <div className="p-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-2">
                <Avatar className="size-6 shrink-0">
                  <AvatarFallback className="text-[10px]">
                    {name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden truncate text-sm font-normal md:inline">{name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel className="truncate">{user?.email ?? name}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={loading}
                onSelect={() => {
                  void signOut();
                }}
              >
                <LogOutIcon />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
