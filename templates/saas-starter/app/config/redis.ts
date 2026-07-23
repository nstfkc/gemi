import { defineRedisConfig } from "gemi/services";

export default defineRedisConfig({
  // Connection URL. Defaults to the REDIS_URL env var; uncomment to set it here.
  // url: "redis://localhost:6379",
  // options: { connectionTimeout: 5000 },
});
