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
        <main className="container max-w-2xl mx-auto px-4">
          {props.children}
        </main>
      </body>
    </html>
  );
};

export default RootLayout;
