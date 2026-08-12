import { describe, expect, it } from "vitest";

import {
  authorizeLineEvent,
  type LineEventAuthorizationPolicy,
} from "../../src/line/authorization.js";
import type {
  NormalizedLineEvent,
  NormalizedLineEventKind,
} from "../../src/line/events.js";

const policy: LineEventAuthorizationPolicy = {
  allowedGroupIds: new Set(["C-allowed"]),
  allowedMemberUserIds: new Set(["U-ming", "U-mei"]),
};

function event(
  kind: NormalizedLineEventKind,
  source: NormalizedLineEvent["source"],
): NormalizedLineEvent {
  return {
    webhookEventId: `E-${kind}`,
    kind,
    rawType: kind,
    lineEventAtMs: 1,
    source,
    isRedelivery: false,
  };
}

describe("authorizeLineEvent", () => {
  it.each(["message", "edit"] as const)(
    "requires an allowed member for an allowed-group %s event",
    (kind) => {
      expect(
        authorizeLineEvent(
          event(kind, {
            type: "group",
            groupId: "C-allowed",
            userId: "U-ming",
          }),
          policy,
        ),
      ).toEqual({ authorized: true });

      expect(
        authorizeLineEvent(
          event(kind, { type: "group", groupId: "C-allowed" }),
          policy,
        ),
      ).toEqual({ authorized: false, reason: "member_user_id_missing" });

      expect(
        authorizeLineEvent(
          event(kind, {
            type: "group",
            groupId: "C-allowed",
            userId: "U-stranger",
          }),
          policy,
        ),
      ).toEqual({ authorized: false, reason: "member_not_allowed" });
    },
  );

  it.each(["join", "unsend"] as const)(
    "allows an allowed-group %s event without userId",
    (kind) => {
      expect(
        authorizeLineEvent(
          event(kind, { type: "group", groupId: "C-allowed" }),
          policy,
        ),
      ).toEqual({ authorized: true });
    },
  );

  it("requires the group allowlist for every event type", () => {
    for (const kind of [
      "message",
      "edit",
      "join",
      "unsend",
      "other",
    ] as const) {
      expect(
        authorizeLineEvent(
          event(kind, {
            type: "group",
            groupId: "C-not-allowed",
            userId: "U-ming",
          }),
          policy,
        ),
      ).toEqual({ authorized: false, reason: "group_not_allowed" });
    }
  });

  it("rejects non-group and malformed group sources", () => {
    expect(
      authorizeLineEvent(
        event("message", { type: "user", userId: "U-ming" }),
        policy,
      ),
    ).toEqual({ authorized: false, reason: "source_not_group" });

    expect(
      authorizeLineEvent(event("unsend", { type: "group" }), policy),
    ).toEqual({ authorized: false, reason: "group_id_missing" });
  });

  it("accepts readonly arrays as allowlists", () => {
    const arrayPolicy: LineEventAuthorizationPolicy = {
      allowedGroupIds: ["C-allowed"],
      allowedMemberUserIds: ["U-ming"],
    };

    expect(
      authorizeLineEvent(
        event("message", {
          type: "group",
          groupId: "C-allowed",
          userId: "U-ming",
        }),
        arrayPolicy,
      ),
    ).toEqual({ authorized: true });
  });
});
