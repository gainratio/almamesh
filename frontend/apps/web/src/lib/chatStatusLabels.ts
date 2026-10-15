/**
 * The chat status lines in the page's language (Dashboard and MeshEdge share them). Kept free
 * of the chat turn itself: the pages load that on send, and this sits in their first chunk.
 */
import type { TFunction } from 'i18next';

import type { ChatStatusLabels } from './chatTurn';

export function chatStatusLabels(t: TFunction): ChatStatusLabels {
  return {
    deciding: t('chat:agent.deciding'),
    answering: t('chat:agent.answering'),
    complete: t('chat:agent.complete'),
    reading: (period) => t('chat:agent.reading', { period }),
    moving: (period) => t('chat:agent.moving', { period }),
    returning: t('chat:agent.returning'),
  };
}
