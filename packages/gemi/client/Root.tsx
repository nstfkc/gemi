import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";

export const Root = (props: any) => {
  const { title, meta = [], link = [] } = props.head;
  return (
    <html>
      <head>
        {props.styles.map((style) => {
          if (style.isDev) {
            return (
              <style key={style.id} type="text/css" data-vite-dev-id={style.id}>
                {style.content}
              </style>
            );
          }
        })}
        <title>{title}</title>
        {meta.map((meta, i) => {
          return <meta key={i} {...meta} />;
        })}
        {link.map((link, i) => {
          return <link key={i} {...link} />;
        })}
      </head>
      <body>
        <div id="root">
          <ServerDataProvider value={props.data}>
            <ClientRouter views={props.views} />
          </ServerDataProvider>
        </div>
      </body>
    </html>
  );
};
