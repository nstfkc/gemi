import { Link } from "gemi/client";

export default function Home(props: { message: string }) {
  return (
    <div>
      <div>
        <h1 className="font-bold text-4xl">Home</h1>
      </div>
      <div>{props.message}</div>
      <div>
        <Link href="/about">About</Link>
      </div>
    </div>
  );
}
