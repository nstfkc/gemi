import { Head, useTheme } from "gemi/client";

import "./main.css";

interface Props {
  children: React.ReactNode;
  locale: string;
}

export default function RootLayout(props: Props) {
  const { theme } = useTheme();
  console.log(theme);
  return (
    <html className={theme} lang={props.locale}>
      <Head />
      <body>{props.children}</body>
    </html>
  );
}
