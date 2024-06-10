import { type ReactNode } from "react";
import { Sidebar } from "./components/Sidebar";
import { NextUIProvider } from "@nextui-org/react";

export default function OrganisationLayout({
  children,
  organisation,
}: {
  organisation: any;
  children: ReactNode;
}) {
  return (
    <NextUIProvider>
      <div className="h-dvh w-screen">
        <div className="flex h-full w-full">
          <div className="min-w-[240px]">
            <Sidebar organisation={organisation} />
          </div>
          <div className="w-full bg-gray-100 p-4">{children}</div>
        </div>
      </div>
    </NextUIProvider>
  );
}
