import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";

export const Main = (props: any) => {
  return (
    <>
      <></>
      <ServerDataProvider>
        <ClientRouter components={props.components} />
      </ServerDataProvider>
    </>
  );
};
