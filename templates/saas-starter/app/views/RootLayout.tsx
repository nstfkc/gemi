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
      <body>{props.children}</body>
    </html>
  );
};

export default RootLayout;
