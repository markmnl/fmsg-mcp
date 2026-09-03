/** Wire types for the fmsg Web API (FMSG-003). Ids are decimal strings. */

export type RecipientDelivery = {
  addr?: string;
  time?: number | null;
  code?: number | null;
};

export type AddToBatch = {
  batch_id?: string;
  add_to_from?: string;
  to?: string[];
  to_delivery?: RecipientDelivery[];
  time?: number | null;
};

export type Attachment = {
  filename: string;
  size: number;
};

export type ReactionGroup = {
  emoji: string;
  from: string[];
};

export type FmsgMessage = {
  /** Present on list items and WebSocket events; absent on GET /fmsg/:id (filled in by the client). */
  id: string;
  version?: number;
  has_pid?: boolean;
  has_add_to?: boolean;
  important?: boolean;
  no_reply?: boolean;
  deflate?: boolean;
  terminal?: boolean;
  pid?: string | null;
  from: string;
  to: string[];
  to_delivery?: RecipientDelivery[];
  add_to?: AddToBatch[];
  /** POSIX seconds; null for drafts. */
  time?: number | null;
  topic?: string;
  type?: string;
  size?: number;
  short_text?: string;
  read?: boolean;
  time_read?: number | null;
  attachments?: Attachment[];
  /** Non-null when this message is itself a reaction. */
  reaction?: string | null;
  reactions?: ReactionGroup[];
};

export type ThreadBody = {
  type: string;
  size: number;
  text?: string;
  download?: string;
  cache_key?: string;
  cacheable?: boolean;
};

export type ThreadAttachment = {
  position: number;
  type: string;
  filename: string;
  size: number;
  download?: string;
  cache_key?: string;
  cacheable?: boolean;
};

export type ThreadMessage = {
  id: string;
  visible: boolean;
  version?: number;
  pid?: string | null;
  from?: string;
  to?: string[];
  add_to?: AddToBatch[];
  time?: number | null;
  topic?: string;
  type?: string;
  size?: number;
  message_sha256?: string;
  body?: ThreadBody;
  attachments?: ThreadAttachment[];
};

export type Thread = {
  root_id: string;
  trigger_id: string;
  complete: boolean;
  messages: ThreadMessage[];
};

export type AccessToken = {
  accessToken: string;
  /** fmsg address from the JWT `sub` claim. */
  address: string;
  expiresAtMs: number;
};

export type OutboundAttachment = {
  filename: string;
  data: Uint8Array;
  contentType?: string;
};

export type SendInput = {
  to: string[];
  body: string;
  type?: string;
  topic?: string;
  pid?: string;
  important?: boolean;
  noReply?: boolean;
  attachments?: OutboundAttachment[];
  signal?: AbortSignal;
};

export type SendResult = {
  id: string;
  time: number | null;
  attachments: Attachment[];
};

export type ReactResult = {
  id: string | null;
  time: number | null;
};

export type WsEventType = "new_msg" | "delivered" | "recipients_added" | "reaction";

export type WsEvent = {
  type: WsEventType | string;
  data?: FmsgMessage;
};
