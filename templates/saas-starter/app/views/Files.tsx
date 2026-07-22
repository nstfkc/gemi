const examples = [
  {
    href: "/files/logo.svg",
    title: "Bun.file() — inline",
    description: "Streams public/logo.svg. Renders in the tab, image/svg+xml.",
  },
  {
    href: "/files/report.csv",
    title: "Generated string — download",
    description: "Built on the fly, sent as an attachment with a filename.",
  },
  {
    href: "/files/hello.txt",
    title: "Bare File instance",
    description: "Returning a Blob/File directly, no descriptor object.",
  },
  {
    href: "/files/invoices/1042",
    title: "Controller handler + params",
    description: "[FileController, 'invoice'] reading req.params.id.",
  },
  {
    href: "/files/raw",
    title: "Response passthrough",
    description: "Handler returns a Response — headers are left untouched.",
  },
  {
    href: "/files/missing.pdf",
    title: "Missing file → 404",
    description: "Bun.file() on a path that does not exist. Expect a clean 404.",
  },
];

export default function Files() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">File routes</h1>
        <p className="text-sm text-neutral-600">
          Each link hits a <code className="font-mono">this.file(...)</code> route. Use plain
          anchors — file routes have no component, so <code className="font-mono">Link</code> cannot
          navigate to them.
        </p>
      </div>

      <ul className="space-y-3">
        {examples.map((example) => (
          <li key={example.href}>
            <a
              href={example.href}
              className="block rounded-md border border-neutral-200 px-4 py-3 hover:bg-neutral-50"
            >
              <span className="block text-sm font-medium">{example.title}</span>
              <span className="block text-sm text-neutral-600">{example.description}</span>
              <span className="mt-1 block font-mono text-xs text-neutral-400">{example.href}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
