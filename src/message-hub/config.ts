/** Canonical WebSocket notification port for every HYTHE runtime surface. */
export const DEFAULT_MESSAGE_HUB_PORT = 3004;

/** Resolve the server port while preserving the existing environment override. */
export function resolveMessageHubPort(
  configuredPort: string | undefined = process.env.MESSAGE_HUB_PORT
): number {
  return Number.parseInt(configuredPort || String(DEFAULT_MESSAGE_HUB_PORT), 10);
}
