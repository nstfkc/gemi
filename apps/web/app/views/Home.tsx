import { Link } from "gemi/client";

export default function Home() {
  return (
    <div>
      <div>
        <h1>Home1</h1>
      </div>
      <div>
        <Link href="/about">About</Link>
      </div>
    </div>
  );
}
