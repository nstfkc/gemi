import "./main.css";

interface Props {
  children: React.ReactNode;
  locale: string;
}

export default function RootLayout(props: Props) {
  return (
    <html lang={props.locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>My app</title>
      </head>
      <body>{props.children}</body>
    </html>
  );
}
