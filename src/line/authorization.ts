import type { NormalizedLineEvent } from "./events.js";

export interface LineEventAuthorizationPolicy {
  allowedGroupIds: ReadonlySet<string> | readonly string[];
  allowedMemberUserIds: ReadonlySet<string> | readonly string[];
}

export type LineEventAuthorizationDenialReason =
  | "source_not_group"
  | "group_id_missing"
  | "group_not_allowed"
  | "member_user_id_missing"
  | "member_not_allowed";

export type LineEventAuthorizationResult =
  | { authorized: true }
  | {
      authorized: false;
      reason: LineEventAuthorizationDenialReason;
    };

function includes(
  values: ReadonlySet<string> | readonly string[],
  candidate: string,
): boolean {
  if (Array.isArray(values)) {
    return values.includes(candidate);
  }

  return (values as ReadonlySet<string>).has(candidate);
}

/**
 * Applies routing authorization without assuming every LINE event has a userId.
 *
 * Every event must come from an allowed group. User-authored message and edit
 * events additionally require an allowed member. System/lifecycle events such
 * as join and unsend are authorized by group even when LINE omits userId.
 */
export function authorizeLineEvent(
  event: NormalizedLineEvent,
  policy: LineEventAuthorizationPolicy,
): LineEventAuthorizationResult {
  if (event.source.type !== "group") {
    return { authorized: false, reason: "source_not_group" };
  }

  const { groupId } = event.source;
  if (groupId === undefined) {
    return { authorized: false, reason: "group_id_missing" };
  }
  if (!includes(policy.allowedGroupIds, groupId)) {
    return { authorized: false, reason: "group_not_allowed" };
  }

  if (event.kind === "message" || event.kind === "edit") {
    const { userId } = event.source;
    if (userId === undefined) {
      return { authorized: false, reason: "member_user_id_missing" };
    }
    if (!includes(policy.allowedMemberUserIds, userId)) {
      return { authorized: false, reason: "member_not_allowed" };
    }
  }

  return { authorized: true };
}
