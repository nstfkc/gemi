import { Link } from "gemi/client";

export default function Home(props) {
  return (
    <div>
      <div>
        <h1 className="font-bold text-4xl">Home1</h1>
      </div>
      <div>{props.message}</div>
      <div>
        <Link href="/about">About</Link>
      </div>
    </div>
  );
}
