import { Link, useLocation } from "gemi/client";
import { useId } from "react";

const Home = (props: { message: string }) => {
  const id = useId();
  const location = useLocation();
  return (
    <div className="">
      <Link href="/auth/sign-in">Sign in</Link>
      <div>
        {location.pathname} - {id}
      </div>
    </div>
  );
};

export default Home;
