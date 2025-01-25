import { Link, useBreadcrumbs } from "gemi/client";

export default function Home() {
  const breadcrumbs = useBreadcrumbs();
  console.log(breadcrumbs);
  return (
    <div>
      <div>
        <h1>Home</h1>
      </div>
      <div>
        <Link href="/about">About</Link>
      </div>
    </div>
  );
}
