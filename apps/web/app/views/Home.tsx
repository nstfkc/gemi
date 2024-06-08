import { Link } from "@/framework/ClientRouterContext";

const Home = (props: { message: string }) => {
  return (
    <div className="">
      <Link href="/auth/sign-in">Sign in xxx</Link>
    </div>
  );
};

export default Home;
