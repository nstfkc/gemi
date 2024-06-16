import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";

export const Main = (props: any) => {
  return (
    <ServerDataProvider value={props.data}>
      <ClientRouter views={props.views} />
    </ServerDataProvider>
  );
};
