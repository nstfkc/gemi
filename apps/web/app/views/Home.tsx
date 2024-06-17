import { Link, useLocation } from "gemi/client";
import { useId } from "react";

const Home = (props: { message: string }) => {
  const id = useId();
  return (
    <div className="">
      <Link href="/auth/sign-in">Sign in</Link>
    </div>
  );
};

export default Home;
