import { createContext } from "react";
import { defaultFetch } from "./defaultFetch"


export const HttpClientContext = createContext({
  fetch: defaultFetch,
  host: "",
});

interface HttpClientProviderProps {
  fetch?: typeof globalThis.fetch;
  host: string;
  children: React.ReactNode;
}

export const HttpClientProvider = ({
  fetch = defaultFetch,
  host = "",
  children,
}: HttpClientProviderProps) => {
  return (
    <HttpClientContext.Provider value={{ fetch, host }}>
      {children}
    </HttpClientContext.Provider>
  );
};
