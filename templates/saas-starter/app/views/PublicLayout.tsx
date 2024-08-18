import { Link, useLocale, useScopedTranslator } from "gemi/client";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const st = useScopedTranslator("layout:/");
  const [locale, setLocale] = useLocale();
  return (
    <div className="container max-w-2xl mx-auto px-4">
      <header className="py-8">
        <nav className="flex gap-4 items-center">
          <Link className="data-[active=true]:underline" href="/">
            {st("home")}
          </Link>
          <Link className="data-[active=true]:underline" href="/about">
            {st("about")}
          </Link>
          <Link href="/auth/sign-in">Sign in</Link>
        </nav>
        <div>
          <button onClick={() => setLocale("en-US")}>English</button>
          <button onClick={() => setLocale("es-ES")}>Espanol</button>
        </div>
      </header>
      <div></div>
      {children}
    </div>
  );
}
