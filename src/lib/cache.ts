import { invoke } from "@tauri-apps/api/core";

// Wraps src-tauri/src/cache.rs's cache_stats/clear_cache.

export interface CacheStats {
  message_count: number;
  size_bytes: number;
}

export function cacheStats(): Promise<CacheStats> {
  return invoke("cache_stats");
}

export function clearCache(): Promise<void> {
  return invoke("clear_cache");
}
