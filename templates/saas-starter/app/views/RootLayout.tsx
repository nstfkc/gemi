import { Link } from "gemi/client";
import "../app.css";

interface Props {
  children: React.ReactNode;
}

const RootLayout = (props: Props) => {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>My app</title>
      </head>
      <body>
        <div className="container max-w-2xl mx-auto px-4">
          <header className="py-8">
            <nav className="flex gap-4 items-center">
              <Link className="data-[active=true]:underline" href="/">
                Home
              </Link>
              <Link className="data-[active=true]:underline" href="/about">
                About
              </Link>
            </nav>
          </header>

          <h1 className="font-bold text-4xl">GEMI</h1>
          {props.children}
        </div>
      </body>
    </html>
  );
};

export default RootLayout;
