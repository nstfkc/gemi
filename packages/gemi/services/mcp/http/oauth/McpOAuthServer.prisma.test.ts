import { memoryOAuthModels } from "./__fixtures__/memoryModel";
import { PrismaMcpOAuthStore } from "./prismaStore";

/**
 * The whole OAuth server suite again, on `PrismaMcpOAuthStore` over in-memory
 * tables that answer Prisma's arguments: every flow (codes, rotation, a
 * replayed code or refresh token revoking the grant, revocation) holds on it
 * as it does on the memory store.
 */
(globalThis as { __gemiMcpOAuthTestStore?: () => unknown }).__gemiMcpOAuthTestStore = () =>
  new PrismaMcpOAuthStore(memoryOAuthModels());

await import("./McpOAuthServer.test");
