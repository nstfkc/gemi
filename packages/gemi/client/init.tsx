import { type ComponentType } from "react";
import { hydrateRoot } from "react-dom/client";
import { Main } from "./main";

export function init(RootLayout: ComponentType<any>) {
  hydrateRoot(
    document,
    <RootLayout>
      <Main />
    </RootLayout>,
  );
}
