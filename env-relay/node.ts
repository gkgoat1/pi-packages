/**
 * @gkgo/pi-packages env relay — Node entrypoint: the dev-box side.
 * `serveEnvRelay` exposes any ExecutionEnv over a transport.
 */

export * from "./index.ts";
export { serveEnvRelay, type ServeEnvRelayOptions } from "./src/serve.ts";
