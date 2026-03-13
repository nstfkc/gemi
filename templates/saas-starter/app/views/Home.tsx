import { useAppIdMissmatch, useQuery, useSearchParams } from "gemi/client";
import { lazy, Suspense, useEffect } from "react";
import { Dict } from "./components/Dict";
import { Translation } from "./components/Translation";
import { TestUI } from "./TestUI";

// const TestUI = lazy(() =>
//   import("./TestUI").then((mod) => ({ default: mod.TestUI })),
// );

function useAppRefresh() {
  const appIdMissmatch = useAppIdMissmatch();

  if (appIdMissmatch) {
    if (confirm("The application has been updated. Reload now?")) {
      caches.keys().then((names) => {
        for (const name of names) {
          console.log("here");
          if (name.includes(".js") && caches) {
            caches.delete(name);
          }
        }
        window.location.reload();
      });
    }
  }
}

export default function Home() {
  const x = useQuery("/org/:orgId/products");
  return (
    <div>
      <h1>Home</h1>
    </div>
  );
}
