import "../app.css";
import { Link } from "gemi/client";

interface Props {
  children: React.ReactNode;
}

const RootLayout = (props: Props) => {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>My gemi app</title>
      </head>
      <body>
        <header>
          <nav>
            <Link href="/">Home</Link>
            <Link href="/about">About</Link>
          </nav>
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
};

export default RootLayout;
