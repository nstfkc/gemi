import { Head } from "gemi/client";
import type { ReactNode } from "react";

// The stylesheet is imported here, in the one component that wraps every page,
// so the view build sees it and gemi can inject the collected CSS during SSR.
// Importing it from a leaf view instead means the first paint of any other
// route arrives unstyled.
import "./main.css";

interface Props {
  children: ReactNode;
  locale: string;
}

export default function RootLayout(props: Props) {
  return (
    // `translate="no"` pairs with the notranslate meta tag `Head` emits: a
    // browser translator that rewrites text nodes before hydration mutates the
    // server-rendered DOM, and React responds by discarding the tree — taking
    // the injected <style> with it. `suppressHydrationWarning` covers the
    // attributes extensions and a theme script add to <html> before React runs.
    <html lang={props.locale} translate="no" suppressHydrationWarning>
      <Head />
      {/* The chat fills the viewport, so the height chain has to start here. */}
      <body className="min-h-dvh">{props.children}</body>
    </html>
  );
}
