import {
  Link,
  OGImage,
  useLocation,
  useSearchParams,
  useTheme,
  useTranslator,
  type ViewProps,
} from "gemi/client";
import { useState } from "react";

export default function Home() {
  const [count, setCount] = useState(0);
  console.log("home render");
  const { setTheme, theme } = useTheme();

  const x = useTranslator("HomePage");

  return (
    <div>
      <div>
        <div>Title: {x("title", { version: "1" })}</div>
      </div>
      <h1>Home</h1>
      <button onClick={() => setTheme("dark")}>Dark</button>
      <button onClick={() => setTheme("light")}>Light</button>
      <button onClick={() => setTheme("system")}>System</button>
      <div>
        <Link href="/" hash="#test">
          Test
        </Link>
        <Link href="/" search={{ test: "test" }}>
          Searh test
        </Link>
      </div>
      <div className="h-[1000px]"></div>
      <div>
        <section id="test" className="h-[500px] bg-red-100">
          <h1>Test</h1>
        </section>
      </div>
    </div>
  );
}
