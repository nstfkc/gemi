import { Link, useRouter } from "gemi/client";

export default function SignIn() {
  const { push } = useRouter();
  return (
    <div>
      <div>Sign In</div>
      <Link href="/">Home</Link>
      <div></div>
    </div>
  );
}
