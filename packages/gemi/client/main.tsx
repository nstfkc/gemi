import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";

export const Main = () => {
  return (
    <>
      <></>
      <ServerDataProvider>
        <ClientRouter views={(window as any).views} />
      </ServerDataProvider>
    </>
  );
};
