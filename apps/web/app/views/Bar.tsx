import { Link } from "gemi/client";

export default function Bar(props) {
  return (
    <div>
      <h2 className="text-green-400">{props.message}</h2>
      <div>
        <Link href="/foo">Foo</Link>
      </div>
    </div>
  );
}
