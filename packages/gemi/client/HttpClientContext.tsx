import { createContext } from "react";

export const HttpClientContext = createContext({
  fetch: (...params: any) => globalThis.fetch.bind(globalThis)(...params),
  host: "",
});

interface HttpClientProviderProps {
  fetch: typeof globalThis.fetch;
  host: string;
  children: React.ReactNode;
}

export const HttpClientProvider = ({
  fetch = globalThis.fetch,
  host = "",
  children,
}: HttpClientProviderProps) => {
  return (
    <HttpClientContext.Provider value={{ fetch, host }}>
      {children}
    </HttpClientContext.Provider>
  );
};
