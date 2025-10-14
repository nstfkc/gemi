import { useAppIdMissmatch } from "gemi/client";

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

  return (
    <div>
      <h1>Home</h1>
    </div>
  );
}
