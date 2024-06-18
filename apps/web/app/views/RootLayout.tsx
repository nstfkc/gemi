import "../app.css";
import { StrictMode } from "react";
import { Main } from "gemi/client";

interface Props {
  styles?: JSX.Element;
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
        <StrictMode>
          <Main viewImportMap={props.viewImportMap} data={props.data} />
        </StrictMode>
      </body>
    </html>
  );
};

export default RootLayout;
