import { useAppIdMissmatch, useQuery } from "gemi/client";

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
  const { data, version, mutate } = useQuery("/health");

  return (
    <div>
      <h1>Home</h1>
      <p>Status: {data?.status ?? "Loading..."}</p>
      <p>Version: {version}</p>
      <button type="button" onClick={() => mutate()}>
        Refresh
      </button>
    </div>
  );
}
