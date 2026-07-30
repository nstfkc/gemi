import { Link, useParams } from "gemi/client";
import type { ReactNode } from "react";
import { Panel, type Stamp } from "./components/Panel";

export default function PartialDemoAlwaysLayout(props: { children: ReactNode; stamp?: Stamp }) {
  const { orgId = "acme" } = useParams() as { orgId?: string };
  const linkClass =
    "rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100 data-[pending=true]:opacity-50";

  return (
    <div className="container mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">alwaysRun()</h1>
      <p className="mt-2 text-slate-600">
        The same shape as the main demo, but this layout is declared with{" "}
        <code className="font-mono">.alwaysRun()</code>. Its number moves on every navigation
        below it, and so does everything nested inside it — segments are skipped as a prefix, so
        nothing under an opted-out layout can be carried on its own.
      </p>

      <nav className="mt-6 flex flex-wrap gap-2">
        <Link className={linkClass} href="/partial/always/:orgId/one" params={{ orgId }}>
          One
        </Link>
        <Link className={linkClass} href="/partial/always/:orgId/two" params={{ orgId }}>
          Two
        </Link>
        <Link className={linkClass} href="/partial/:orgId" params={{ orgId }}>
          Back to the main demo
        </Link>
      </nav>

      <div className="mt-6">
        <Panel stamp={props.stamp} kind="layout">
          <div className="space-y-4">{props.children}</div>
        </Panel>
      </div>
    </div>
  );
}
