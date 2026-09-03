import { Link } from "gemi/client";
import {
  ArrowRightIcon,
  BookOpenIcon,
  GitBranchIcon,
  ListChecksIcon,
  MessageSquareTextIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Every entry names a real file and a real tool, because the whole value of a
// landing page on a template is that it is a map of the source rather than
// copy. If one of these stops matching `app/agents/`, fix the code or fix the
// card — a demo that describes itself wrongly is worse than one that says
// nothing.
const DEMONSTRATED: { icon: LucideIcon; title: string; where: string; body: string }[] = [
  {
    icon: WrenchIcon,
    title: "Plain tools",
    where: "lookupOrders, orderDetail",
    body: "An input schema, an output schema, and an async function. The schemas type the browser as well as the model.",
  },
  {
    icon: SquareTerminalIcon,
    title: "Progress from a generator",
    where: "runDiagnostics",
    body: "An async generator, so every yield reaches the transcript as a line while the tool is still running.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Approval before it runs",
    where: "issueRefund",
    body: "The run stops and waits for a signed yes from the person watching. What they approve is the input the server saw.",
  },
  {
    icon: MessageSquareTextIcon,
    title: "A question for the customer",
    where: "AgentTool.ask",
    body: "Answered by the human, not the server: the same suspend-and-resume machinery an approval uses.",
  },
  {
    icon: ListChecksIcon,
    title: "A deferred namespace",
    where: "app/agents/billing.ts",
    body: "Three billing tools that withhold their schemas until the model goes looking for one, so quiet turns pay nothing for them.",
  },
  {
    icon: BookOpenIcon,
    title: "A skill",
    where: "app/skills/refund-policy.md",
    body: "Instructions the model fetches rather than carries, so the refund policy is not in every prompt about a parcel.",
  },
  {
    icon: GitBranchIcon,
    title: "A sub-agent",
    where: "app/agents/research.ts",
    body: "A second agent, run through ctx.runAgent, whose transcript renders inside the tool call that started it.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col gap-20">
      <section className="flex flex-col items-start gap-6">
        <span className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
          A gemi template
        </span>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          A support agent you can watch think, and stop mid-thought.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground text-pretty">
          Every tool call, every question it asks you, and every refund it wants your sign-off on
          shows up in the transcript as it happens. It is a small, made-up support desk whose real
          job is to be the shortest readable example of gemi&apos;s agent API.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/chat"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
          >
            Open the chat
            <ArrowRightIcon className="size-4" />
          </Link>
          <Link
            href="/auth/sign-up"
            className="inline-flex h-10 items-center rounded-md border border-border px-5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            Create an account
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          The chat is behind the <code className="font-mono">auth</code> middleware, so signing in
          is the whole gate — a thread belongs to the user the route minted it for.
        </p>
      </section>

      <section className="flex flex-col gap-6">
        <h2 className="text-2xl font-semibold tracking-tight">What it demonstrates</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DEMONSTRATED.map(({ icon: Icon, title, where, body }) => (
            <div
              key={title}
              className="flex flex-col gap-2 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xs"
            >
              <Icon className="size-5 text-primary" />
              <h3 className="font-medium">{title}</h3>
              <code className="font-mono text-xs text-muted-foreground">{where}</code>
              <p className="text-sm text-muted-foreground text-pretty">{body}</p>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          The tool bodies are fakes with canned data on purpose. There is no database behind the
          orders and no payment processor behind the refunds; the template teaches the API, and a
          real one would only be in the way.
        </p>
      </section>
    </div>
  );
}
