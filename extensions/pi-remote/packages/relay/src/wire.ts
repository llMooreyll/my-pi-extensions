// MUST stay identical to the corresponding constants in packages/protocol/src/relay.ts.
// The relay is deployed on its own (Docker copies only this directory), so it cannot import the protocol package.
export const RELAY_PATH_CLIENT = "/v1/client";
export const RELAY_PATH_HOST_CONTROL = "/v1/host/control";
export const RELAY_PATH_HOST_DATA = "/v1/host/data";

export const CLOSE = {
  HOST_OFFLINE: 4404,
  HOST_REPLACED: 4409,
  BAD_RELAY_SECRET: 4401,
  PAIR_TIMEOUT: 4504,
  RATE_LIMITED: 4429,
  UNAUTHORIZED: 4411,
  AUTH_TIMEOUT: 4408,
} as const;
