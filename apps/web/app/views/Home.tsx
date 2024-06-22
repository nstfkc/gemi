import { Link } from "gemi/client";

export default function Home(props: { count: number }) {
  return (
    <div className="py-4">
      <div>
        <h1 className="font-bold text-4xl">Gemi</h1>
        <Link href="/foo">Foo</Link>
        <Link href="/foo/bar">FooBar</Link>
      </div>
    </div>
  );
}
