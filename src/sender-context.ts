import { ChannelType, type BotMessage } from './octo/types.js';
import { safeSenderMetadata, type SafeText } from './prompt-safety.js';
import { isRegistrationOwner, normalizeOwnerUid, transportSpaceId } from './owner-identity.js';
import { parentGroupNo } from './channel-id.js';
import { normalizeInboundMention, normalizeMessageId } from './inbound-mention.js';
import { isAuthenticCronFire } from './cron-fire-marker.js';

function senderMetadata(message: BotMessage, ownerUid: string, botUid?: string) {
  const senderUid = normalizeOwnerUid(message.from_uid);
  const channelId = typeof message.channel_id === 'string' && message.channel_id.length > 0
    && message.channel_id.length <= 512 ? message.channel_id : null;
  const senderSpace = transportSpaceId(senderUid, ownerUid);
  // Split before topic extraction so even malformed topic-typed compound
  // channels cannot hide another endpoint. DM endpoint UIDs stay opaque.
  const endpoints = channelId?.split('@').map((endpoint) =>
    message.channel_type === ChannelType.CommunityTopic ? parentGroupNo(endpoint) : endpoint);
  const prefix = `s${senderSpace}_`;
  const matchesChannel = endpoints !== undefined
    && endpoints.every((endpoint) => endpoint.startsWith(prefix) && endpoint.length > prefix.length);
  const metadata = {
    message_id: normalizeMessageId(message.message_id),
    // An authenticated internal trigger is not an original IM mention.
    ...normalizeInboundMention(message.payload && !isAuthenticCronFire(message.payload)
      ? message.payload.mention : undefined, botUid),
    from_uid: senderUid,
    channel_id: channelId,
    channel_type: message.channel_type !== undefined && [ChannelType.DM, ChannelType.Group, ChannelType.CommunityTopic].includes(message.channel_type)
      ? message.channel_type : null,
    is_owner: isRegistrationOwner(senderUid, ownerUid)
      || (matchesChannel && isRegistrationOwner(senderUid, ownerUid, senderSpace)),
  };
  return metadata;
}

/** Privileged controls require the exact registration UID. The current Bot API
 * returns owner_channel_id === owner_uid, so that field supplies no trusted
 * namespace binding. Prompt is_owner above is advisory legacy attribution and
 * may recognize a scoped alias; it must never authorize a control command.
 */
export function isOwnerSender(message: BotMessage, ownerUid: string): boolean {
  return isRegistrationOwner(message.from_uid, ownerUid);
}
export function buildSenderContext(message: BotMessage, ownerUid: string, botUid?: string): SafeText {
  return safeSenderMetadata(senderMetadata(message, ownerUid, botUid));
}
