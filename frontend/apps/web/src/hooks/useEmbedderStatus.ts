import { useSyncExternalStore } from 'react';

import { embedderStatus, type EmbedderStatus } from '../lib/embedderStatus';

/** Live load state of the on-device chat embedder (see lib/embedderStatus). */
export function useEmbedderStatus(): EmbedderStatus {
  return useSyncExternalStore(embedderStatus.subscribe, embedderStatus.get, embedderStatus.get);
}
