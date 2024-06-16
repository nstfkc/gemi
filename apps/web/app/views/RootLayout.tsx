import "../app.css";
import { StrictMode, lazy, type ComponentType } from "react";
import { Main } from "gemi/client";

const views = Object.entries(
  import.meta.glob(["./**/*.tsx", "!./**/components/**"]),
).reduce((acc, [path, importer]) => {
  return {
    ...acc,
    [path]: lazy(
      importer as () => Promise<{ default: ComponentType<unknown> }>,
    ),
  };
}, {});

const RootLayout = (props: any) => {
  const { styles = [] } = props;
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {styles.map((style) => {
          if (style.isDev) {
            return (
              <style key={style.id} type="text/css" data-vite-dev-id={style.id}>
                {style.content}
              </style>
            );
          }
        })}
        <title>My app</title>
      </head>
      <body>
        <StrictMode>
          <Main views={views} data={props.data} />
        </StrictMode>
      </body>
    </html>
  );
};

export default RootLayout;
