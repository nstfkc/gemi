import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";

export const Main = (props: any) => {
  return (
    <ServerDataProvider value={props.data}>
      <ClientRouter viewImportMap={props.viewImportMap} />
    </ServerDataProvider>
  );
};
