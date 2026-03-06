import type { InboundMessage } from "../channels/types.ts";
import type { OwnerStore } from "./owner-store.ts";

const INTERNAL_CHANNEL_TYPES = new Set(["cli", "project", "subagent", "system"]);

export type MessageClassification =
  | { type: "owner" }
  | { type: "no_owner_configured"; channelType: string }
  | { type: "untrusted"; channelType: string; userId?: string };

export function classifyMessage(
  message: InboundMessage,
  ownerStore: OwnerStore,
): MessageClassification {
  const { type: channelType, userId } = message.channel;

  // 1. Internal channels (cli, project, subagent) → always trusted
  if (INTERNAL_CHANNEL_TYPES.has(channelType)) {
    return { type: "owner" };
  }

  // 2. External channel with no owner configured for that type
  if (!ownerStore.hasChannel(channelType)) {
    return { type: "no_owner_configured", channelType };
  }

  // 3. External channel, userId matches a registered owner
  if (userId !== undefined && ownerStore.isOwner(channelType, userId)) {
    return { type: "owner" };
  }

  // 4. External channel, userId doesn't match (or no userId)
  return { type: "untrusted", channelType, userId };
}
