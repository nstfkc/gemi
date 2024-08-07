import { Link } from "gemi/client";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="container max-w-2xl mx-auto px-4">
      <header className="py-8">
        <nav className="flex gap-4 items-center">
          <Link className="data-[active=true]:underline" href="/">
            Home
          </Link>
          <Link className="data-[active=true]:underline" href="/about">
            About
          </Link>
          <Link href="/auth/sign-in">Sign in</Link>
        </nav>
      </header>
      {children}
    </div>
  );
}
