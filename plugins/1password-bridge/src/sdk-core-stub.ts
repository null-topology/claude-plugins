/**
 * Stands in for `@1password/sdk-core` in the broker bundle (scripts/build.mjs).
 *
 * The real package is the SDK's wasm core, 13.9 MB. Desktop authentication
 * talks to the 1Password app through its native library (`SharedLibCore`) and
 * never calls the wasm core; only service-account clients and the static
 * `Secrets` helpers do, and the broker uses neither. Every entry point
 * therefore refuses, so a code path that would need the wasm core fails loudly
 * instead of loading a file the plugin does not ship.
 */

const REFUSAL = '1password-bridge ships desktop authentication only';

export async function init_client(_config: string): Promise<string> {
  throw new Error(REFUSAL);
}

export async function init_client_oidc(_config: string, _fetcher: unknown): Promise<string> {
  throw new Error(REFUSAL);
}

export async function invoke(_parameters: string): Promise<string> {
  throw new Error(REFUSAL);
}

export function invoke_sync(_parameters: string): string {
  throw new Error(REFUSAL);
}

export function release_client(_clientId: string): void {
  throw new Error(REFUSAL);
}
