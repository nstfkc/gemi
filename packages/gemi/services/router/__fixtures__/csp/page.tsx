import { Suspense, useEffect, useState, type ReactNode } from "react";

import { useCspNonce } from "../../../../client/cspNonce";
import { Head } from "../../../../client/Head";
import type { RootLayoutProps } from "../../../../client/htmlAttributes";
import { useQuery } from "../../../../client/useQuery";

/**
 * The page `cspNonce.chrome.test.ts` serves under the strict policy (#1195),
 * shared by the server render and the client bundle: a streamed query behind
 * a Suspense boundary, an inline script of the app's own and a button that
 * only works once the page has hydrated.
 */

function Slow() {
  const { data } = useQuery("/slow" as never);
  return <p id="slow">{JSON.stringify(data)}</p>;
}

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    (window as any).__hydrated = true;
  }, []);
  return (
    <button id="count" type="button" onClick={() => setCount((n) => n + 1)}>
      {count}
    </button>
  );
}

function Home() {
  return (
    <main>
      <Counter />
      <Suspense fallback={<p id="slow">loading</p>}>
        <Slow />
      </Suspense>
    </main>
  );
}

const NotFound = () => <p>not found</p>;

function AppScript() {
  const nonce = useCspNonce();
  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: "window.__appScript=true" }}
    />
  );
}

export const Layout = (props: RootLayoutProps & { children?: ReactNode }) => (
  <html {...props.htmlAttributes}>
    <Head />
    <body>
      <AppScript />
      {props.children}
    </body>
  </html>
);

export const views: Record<string, any> = { "404": NotFound, Home };
