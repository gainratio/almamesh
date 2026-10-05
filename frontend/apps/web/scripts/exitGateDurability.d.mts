export type EngineCacheStorage =
  | { readonly persistence: 'opfs'; readonly pool: string; readonly file: string }
  | { readonly persistence: 'memory'; readonly reason: string; readonly detail?: string }

export function cachePoolDirectory(storage: EngineCacheStorage | null | undefined): string | null
