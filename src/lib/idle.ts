import { invoke, isTauri } from "@tauri-apps/api/core";

// Thin wrappers around src-tauri/src/idle.rs. Each call is a no-op in
// browser-only dev mode (no backend available).

export function startIdle(accountId: string, host: string, port: number, folder: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("start_idle", { accountId, host, port, folder });
}

export function stopIdle(accountId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("stop_idle", { accountId });
}

export function stopAllIdle(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("stop_all_idle");
}
