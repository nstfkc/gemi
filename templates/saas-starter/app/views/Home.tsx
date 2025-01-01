import { Link } from "gemi/client";
import styles from "./test.module.css";

export default function Home() {
  return (
    <div>
      <div>
        <h1>Home</h1>
      </div>
      <div className={styles.awesome}>Hidden</div>
      <div>
        <Link className={styles.bgRed} href="/auth/sign-in">
          Sign In
        </Link>
      </div>
    </div>
  );
}
