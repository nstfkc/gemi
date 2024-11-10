declare var self: Worker;

self.onmessage = async (event: MessageEvent) => {
  const { APP_DIR } = event.data;
  console.log("APP", APP_DIR);
  const mod = await import(`${APP_DIR}/bootstrap.ts`);
  console.log(mod.app);
  postMessage(APP_DIR);
};

export {};
