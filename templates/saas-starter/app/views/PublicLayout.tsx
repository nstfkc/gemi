import { Link, OpenGraphImage, useLocale, type ViewProps } from "gemi/client";
import type { ReactNode } from "react";
import { BrainIcon } from "lucide-react";

const Header = () => {
  const [locale, setLocale] = useLocale();
  return (
    <header>
      <nav className="container max-w-4xl mx-auto px-4 lg:px-0">
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
        <div className="flex gap-4">
          <button onClick={() => setLocale("tr-TR")}>TR-TR</button>
          <button onClick={() => setLocale("en-US")}>EN-US</button>
        </div>
      </nav>
    </header>
  );
};

const Footer = () => {
  return (
    <footer className="bg-emerald-200 pt-16 pb-4">
      <div className="container max-w-4xl mx-auto px-4 lg:px-0">
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
      <main className="container max-w-4xl mx-auto px-4 lg:px-0">
        {children}
      </main>
      <Footer />
    </>
  );
}

export async function OpenGraph(data: ViewProps<"/">) {
  return (
    <OpenGraphImage
      width={600}
      height={400}
      fonts={[
        {
          name: "Open Sans",
          weight: 400,
          style: "normal",
        },
      ]}
    >
      <div
        style={{
          width: "600px",
          height: "400px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#FFF",
        }}
      >
        <img width={32} src="http://localhost:5173/gemi.svg" />
        <div>Hello world</div>
        <div>Enes tufekci</div>
      </div>
    </OpenGraphImage>
  );
}
