import { Link, useLocation, useRouter } from "gemi/client";
import { FormError, Mutation } from "gemi/client";
import { Root } from "@radix-ui/react-accordion";
import { motion, useAnimate } from "framer-motion";
import { AArrowDown } from "lucide-react";

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
