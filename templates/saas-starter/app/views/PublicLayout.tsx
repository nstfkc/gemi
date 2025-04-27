import { Link, useLocale } from "gemi/client";
import { type ReactNode } from "react";
import { BrainIcon } from "lucide-react";

const Header = () => {
  const [locale, setLocale] = useLocale();
  return (
    <header>
      <nav className="container max-w-4xl mx-auto">
        <div className="flex justify-between items-center py-8">
          <Link href="/">
            <BrainIcon /> brain.co
          </Link>
          <div className="flex gap-16 items-center">
            <Link href="/about">About</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/auth/sign-in">Sign In</Link>
          </div>
        </div>
        <div>
          <button onClick={() => setLocale("es")}>Es</button>
          <button onClick={() => setLocale("en-US")}>EN-US</button>
        </div>
      </nav>
    </header>
  );
};

const Footer = () => {
  return (
    <footer className="bg-emerald-200 pt-16 pb-4">
      <div className="container max-w-4xl mx-auto">
        <div className="flex justify-between">
          <div>
            <Link href="/">
              <BrainIcon />
              brain.co
            </Link>
          </div>
          <div className="flex flex-col gap-4">
            <Link href="/about">About</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/auth/sign-in">Sign In</Link>
          </div>
        </div>

        <div className="text-xs text-center">2025 brain.co</div>
      </div>
    </footer>
  );
};

export default function PublicLayout(props: { children: ReactNode }) {
  const { children } = props;
  return (
    <>
      <Header />
      <main className="container max-w-4xl mx-auto">{children}</main>
      <Footer />
    </>
  );
}
