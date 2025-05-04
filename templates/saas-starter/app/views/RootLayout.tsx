import { Head } from "gemi/client";

import "./main.css";

interface Props {
  children: React.ReactNode;
  locale: string;
}

export default function RootLayout(props: Props) {
  return (
    <html lang={props.locale}>
      <Head />
      <body>{props.children}</body>
    </html>
  );
}
