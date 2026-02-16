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
  const { data, version, mutate, refetch } = useQuery(
    "/health",
    {},
    { lazy: false },
  );
  const searchParams = useSearchParams();

  return (
    <div>
      <h1>Home</h1>
      <pre>{JSON.stringify(data, null, 2)}</pre>
      <p>Version: {version}</p>
      <button type="button" onClick={() => refetch()}>
        Refresh
      </button>
      <button
        onClick={() => {
          searchParams.set("test", "123").push();
        }}
      >
        Test
      </button>
    </div>
  );
}
