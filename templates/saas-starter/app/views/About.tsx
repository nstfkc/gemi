import { AnimatePresence, motion } from "framer-motion";
import { Link, useBreadcrumbs, useNavigate, type ViewProps } from "gemi/client";
import { useEffect } from "react";

export default function About(props: ViewProps<"/:about">) {
  const breadcrumbs = useBreadcrumbs();
  console.log(breadcrumbs);
  return (
    <div>
      About
      <div>
        <Link href="/">HOme</Link>
      </div>
    </div>
  );
}
