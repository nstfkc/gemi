import {
  Link,
  useLocale,
  useNavigationProgress,
  useRoute,
  useScopedTranslator,
} from "gemi/client";
import { useState } from "react";
import { LoadingBar } from "./components/LoadingBar";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const st = useScopedTranslator("layout:/");
  const [locale, setLocale] = useLocale();
  const { pathname } = useRoute();
  return (
    <div>
      <LoadingBar />
      <div className="container max-w-2xl mx-auto px-4">
        <header className="py-8">
          <nav className="flex gap-4 items-center">
            <Link className="data-[active=true]:underline" href="/">
              {st("home")}
            </Link>
            <Link className="data-[active=true]:underline" href="/about">
              {st("about")}
            </Link>
            <Link
              className="data-[active=true]:underline"
              href="/:testId"
              params={{ testId: "1234" }}
            >
              Test
            </Link>
            <Link href="/auth/sign-in">Sign in</Link>
          </nav>
          <div>
            <button onClick={() => setLocale("en-US")}>English</button>
            <button onClick={() => setLocale("es-ES")}>Espanol</button>
          </div>
        </header>
        <div>{pathname}</div>
        {children}
      </div>
    </div>
  );
}
