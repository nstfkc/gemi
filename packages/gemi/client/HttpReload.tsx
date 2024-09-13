import { useEffect, useState } from "react";
import { useNavigate } from "./useNavigate";
import { useSearchParams } from "./useSearchParams";
import { useRoute } from "./useRoute";
import { useParams } from "./useParams";
import { createPortal } from "react-dom";

export const HttpReload = () => {
  const { replace } = useNavigate();
  const searchParams = useSearchParams();
  const { pathname } = useRoute();
  const params = useParams();
  const [reloading, setReloading] = useState(false);
  const handleReload = () => {
    setReloading(true);
    replace(pathname, {
      params: params,
      search: searchParams.toJSON(),
    } as any)
      .catch(console.log)
      .finally(() => {
        setReloading(false);
      });
  };
  useEffect(() => {
    // @ts-ignore
    if (import.meta.hot) {
      // @ts-ignore
      import.meta.hot.on("vite:beforeFullReload", () => {
        console.log("HELLO");
        throw "(skipping full reload)";
      });
      import.meta.hot.on("beforeFullReload", () => {
        console.log("HELLO");
        throw "(skipping full reload)";
      });
    }
    return () => {
      // @ts-ignore
      if (import.meta.hot) {
        // @ts-ignore
        import.meta.hot.off("http-reload", handleReload);
      }
    };
  }, [handleReload]);

  if (!reloading || typeof document === "undefined") {
    return null;
  }
  return createPortal(
    <div className="fixed z-[1000] bottom-0 right-0 p-2">
      <div className="p-2 bg-white text-black rounded-md shadow-md">...</div>
    </div>,
    document.body,
  );
};
