import { useAppIdMissmatch, useQuery, useSearchParams } from "gemi/client";
import { useEffect } from "react";

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
  useAppRefresh();
  const { data, version, trigger, prefetch } = useQuery(
    "/health",
    {},
    {
      lazy: true,
      refetchUntil: (data) => {
        if (data.status === "ok") {
          return 0;
        }
        return 20000;
      },
    },
  );
  const searchParams = useSearchParams();

  return (
    <div>
      <h1>Home</h1>
      <pre>{JSON.stringify(data, null, 2)}</pre>
      <p>Version: {version}</p>
      <button type="button" onClick={() => prefetch()}>
        Prefetch
      </button>
      <button
        onClick={() => {
          trigger();
        }}
      >
        Trigger
      </button>
    </div>
  );
}
