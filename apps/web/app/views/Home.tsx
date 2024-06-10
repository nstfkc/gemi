import { NextUIProvider, Button } from "@nextui-org/react";
import { Link } from "gemi/client";

const Home = (props: { message: string }) => {
  return (
    <NextUIProvider>
      <div className="">
        <Button>
          <Link href="/auth/sign-in">Sign in xxx</Link>
        </Button>
      </div>
    </NextUIProvider>
  );
};

export default Home;
