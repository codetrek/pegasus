/**
 * Channel types — defines the interface between channel adapters and Main Agent.
 */

/** Channel identification — where the message came from. */
export interface ChannelInfo {
  type: string; // "cli" | "slack" | "sms" | "web" | "api"
  channelId: string; // unique channel instance
  userId?: string;
  replyTo?: string; // thread ID, conversation ID
}

/** Callback for storing images. Undefined when vision is disabled. */
export type StoreImageFn = (
  buffer: Buffer,
  mimeType: string,
  source: string,
) => Promise<{ id: string; mimeType: string }>;

/** Inbound message from any channel. */
export interface InboundMessage {
  text: string;
  channel: ChannelInfo;
  images?: Array<{ id: string; mimeType: string }>;
  metadata?: Record<string, unknown>;
}

/** Structured content for outbound messages. */
export interface OutboundContent {
  text: string;
  images?: Array<{ id: string; data: string; mimeType: string }>;
  // Future: fileId?, audioId?
}

/** Outbound response from Main Agent. */
export interface OutboundMessage {
  text: string;  // Keep for backward compat (plain text shorthand)
  channel: ChannelInfo;
  content?: OutboundContent;  // Structured content (when images present)
  metadata?: Record<string, unknown>;
}

/** Channel adapter interface. */
export interface ChannelAdapter {
  readonly type: string;
  start(agent: { send(msg: InboundMessage): void }): Promise<void>;
  deliver(message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}
