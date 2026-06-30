import { describe, expect, test } from "bun:test";
import { normalizeInstagramWebhook } from "../src/webhook/normalize";

describe("webhook normalization", () => {
  test("normalizes comments for the connected Instagram account", () => {
    const result = normalizeInstagramWebhook(
      {
        entry: [
          {
            id: "ig_account",
            time: 1777978800,
            changes: [
              {
                field: "comments",
                value: {
                  id: "comment_1",
                  text: "хочу",
                  media: { id: "media_1" },
                  from: { id: "user_1", username: "user" },
                },
              },
            ],
          },
        ],
      },
      "ig_account",
    );

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.id).toBe("comment_1");
    expect(result.comments[0]?.commentKind).toBe("feed");
  });

  test("marks live_comments as live comments", () => {
    const result = normalizeInstagramWebhook(
      {
        entry: [
          {
            id: "ig_account",
            changes: [
              {
                field: "live_comments",
                value: {
                  id: "live_comment_1",
                  text: "хочу",
                  media: { id: "live_media_1" },
                },
              },
            ],
          },
        ],
      },
      "ig_account",
    );

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.commentKind).toBe("live");
  });

  test("skips entries for a different Instagram account", () => {
    const result = normalizeInstagramWebhook(
      {
        entry: [
          {
            id: "other_account",
            changes: [
              {
                field: "comments",
                value: {
                  id: "comment_1",
                  text: "хочу",
                  media: { id: "media_1" },
                },
              },
            ],
          },
        ],
      },
      "ig_account",
    );

    expect(result.comments).toEqual([]);
    expect(result.unsupportedCount).toBe(1);
  });

  test("normalizes inbound text direct messages", () => {
    const result = normalizeInstagramWebhook(
      {
        entry: [
          {
            id: "ig_account",
            time: 1777978800,
            messaging: [
              {
                sender: { id: "user_1" },
                recipient: { id: "ig_account" },
                timestamp: 1777978800123,
                message: {
                  mid: "dm_1",
                  text: "🦐",
                },
              },
            ],
          },
        ],
      },
      "ig_account",
    );

    expect(result.directMessages).toEqual([
      {
        id: "dm_1",
        senderId: "user_1",
        recipientId: "ig_account",
        text: "🦐",
        createdAt: "2026-05-05T11:00:00.123Z",
        source: "webhook",
        raw: {
          sender: { id: "user_1" },
          recipient: { id: "ig_account" },
          timestamp: 1777978800123,
          message: {
            mid: "dm_1",
            text: "🦐",
          },
        },
      },
    ]);
    expect(result.unsupportedCount).toBe(0);
  });

  test("ignores unsupported direct message webhook entries", () => {
    const result = normalizeInstagramWebhook(
      {
        entry: [
          {
            id: "ig_account",
            messaging: [
              {
                sender: { id: "user_1" },
                recipient: { id: "ig_account" },
                message: { mid: "echo_1", text: "🦐", is_echo: true },
              },
              {
                sender: { id: "ig_account" },
                recipient: { id: "user_1" },
                message: { mid: "self_1", text: "🦐" },
              },
              {
                sender: { id: "user_1" },
                recipient: { id: "ig_account" },
                message: { mid: "attachment_1", attachments: [] },
              },
              {
                sender: { id: "user_1" },
                recipient: { id: "ig_account" },
                message: { text: "🦐" },
              },
            ],
          },
        ],
      },
      "ig_account",
    );

    expect(result.directMessages).toEqual([]);
    expect(result.unsupportedCount).toBe(4);
  });
});
