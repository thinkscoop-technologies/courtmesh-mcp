import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries a per request API key override (the ?token= query parameter in
 * HTTP mode) down to tool handlers without threading it through every
 * function signature. In stdio mode this is never set, so tools fall back
 * to the COURTMESH_API_KEY environment variable.
 */
export const apiKeyOverrideStorage = new AsyncLocalStorage<string | undefined>();

export function getApiKeyOverride(): string | undefined {
  return apiKeyOverrideStorage.getStore();
}
