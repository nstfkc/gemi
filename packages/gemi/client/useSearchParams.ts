import { useLocation } from "./ClientRouterContext";
import { useRouter } from "./useRouter";

export function useSearchParams() {
  const { push } = useRouter();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const setSearchParams = (
    newSearchParams:
      | URLSearchParams
      | ((searchParams: URLSearchParams) => URLSearchParams),
    shallow = false,
  ) => {
    let nextSearchParams = newSearchParams;
    if (typeof newSearchParams === "function") {
      nextSearchParams = newSearchParams(searchParams);
    }

    push(location.pathname as never, {
      search: Object.fromEntries(
        (nextSearchParams as URLSearchParams).entries(),
      ),
      shallow,
    });
  };

  return [searchParams, setSearchParams] as const;
}
