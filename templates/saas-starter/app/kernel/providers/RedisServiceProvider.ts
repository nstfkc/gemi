import { RedisServiceProvider } from "gemi/services";

export default class extends RedisServiceProvider {
  // Connection URL. Defaults to the REDIS_URL env var; uncomment to set it here.
  // url = "redis://localhost:6379";
  // options = { connectionTimeout: 5000 };
}
