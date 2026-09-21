import { TOPIC_CHANNEL_SEPARATOR } from './octo/types.js';

/** Group APIs address the parent group; conversation state keeps the full topic ID. */
export function parentGroupNo(channelId: string): string {
  return channelId.split(TOPIC_CHANNEL_SEPARATOR, 1)[0];
}
