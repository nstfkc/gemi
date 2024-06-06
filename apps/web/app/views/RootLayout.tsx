import "../app.css";
import { StrictMode, type ReactNode } from "react";
import { NextUIProvider } from "@nextui-org/react";

const RootLayout = ({ children }: { children: ReactNode }) => {
  return (
    <StrictMode>
      <NextUIProvider>{children}</NextUIProvider>
    </StrictMode>
  );
};

export default RootLayout;
