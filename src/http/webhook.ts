import type { LineEventAuthorizationResult, NormalizedLineEvent } from "../line/index.js";
import {
  authorizeLineEvent,
  parseLineWebhookBody,
  verifyLineWebhookSignature,
} from "../line/index.js";

export interface AcceptedLineEvent {
  event: NormalizedLineEvent;
  authorization: LineEventAuthorizationResult;
}

export interface LineEventInbox {
  acceptBatch(destination: string, events: readonly AcceptedLineEvent[]): Promise<void>;
}

export interface WebhookDependencies {
  channelSecret: string;
  allowedGroupId: string;
  allowedMemberUserIds: ReadonlySet<string>;
  publicSignupEnabled?: boolean;
  inbox: LineEventInbox;
}

export type WebhookResult =
  | { status: 200; code: "accepted" }
  | { status: 400; code: "invalid_body" }
  | { status: 401; code: "invalid_signature" }
  | { status: 503; code: "inbox_unavailable" };

export async function handleLineWebhook(
  rawBody: Uint8Array,
  signature: string | null | undefined,
  dependencies: WebhookDependencies,
): Promise<WebhookResult> {
  if (!verifyLineWebhookSignature(rawBody, signature, dependencies.channelSecret)) {
    return { status: 401, code: "invalid_signature" };
  }

  let webhook;
  try {
    webhook = parseLineWebhookBody(rawBody);
  } catch {
    return { status: 400, code: "invalid_body" };
  }

  const events = webhook.events.map((event) => ({
    event,
    authorization: authorizeLineEvent(event, {
      allowedGroupIds: new Set([dependencies.allowedGroupId]),
      allowedMemberUserIds: dependencies.allowedMemberUserIds,
      allowUnlistedGroups: dependencies.publicSignupEnabled ?? false,
    }),
  }));

  try {
    await dependencies.inbox.acceptBatch(webhook.destination, events);
  } catch {
    return { status: 503, code: "inbox_unavailable" };
  }

  return { status: 200, code: "accepted" };
}
