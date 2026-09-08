import { describe, expect, test } from "bun:test";
import { MetaApiError, MetaGraphClient } from "../src/meta/client";
import { defaultAppConfig } from "./helpers/config";

describe("MetaGraphClient", () => {
  test("refreshes a long-lived token through the unversioned Instagram endpoint", async () => {
    const client = new MetaGraphClient(config(), async (input, init) => {
      const url = new URL(input);
      expect(url.origin + url.pathname).toBe("https://graph.instagram.com/refresh_access_token");
      expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
      expect(url.searchParams.get("access_token")).toBe("token");
      expect(init?.signal).toBeDefined();
      return Response.json({ access_token: "renewed", token_type: "bearer", expires_in: 5184000 });
    });
    expect(await client.refreshAccessToken()).toEqual({ accessToken: "renewed", expiresIn: 5184000 });
  });

  test("refresh errors never expose response bodies or URLs containing tokens", async () => {
    for (const response of [
      () => Response.json({ access_token: "leaked-secret", expires_in: 0 }),
      () => Response.json({ error: { message: "leaked-secret", code: 190 } }, { status: 400 }),
      () => { throw new Error("https://graph.instagram.com/?access_token=leaked-secret"); },
    ]) {
      const client = new MetaGraphClient(config(), async () => response());
      try {
        await client.refreshAccessToken();
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).not.toContain("leaked-secret");
        expect(String(error)).not.toContain("expected rejection");
        expect(JSON.stringify(error)).not.toContain("leaked-secret");
      }
    }
  });

  test("sends private replies with comment_id recipient", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const client = new MetaGraphClient(config(), async (url, init) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ recipient_id: "user", message_id: "message" }));
    });

    const response = await client.sendPrivateReply("comment_1", "Привет");

    expect(response.message_id).toBe("message");
    expect(capturedUrl).toBe("https://graph.instagram.com/v25.0/ig_account/messages");
    expect(JSON.parse(capturedBody)).toEqual({
      recipient: { comment_id: "comment_1" },
      message: { text: "Привет" },
    });
  });

  test("sends direct messages with Instagram-scoped user id recipient", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const client = new MetaGraphClient(config(), async (url, init) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ recipient_id: "user_1", message_id: "message_1" }));
    });

    const response = await client.sendDirectMessage("user_1", "Привет");

    expect(response.message_id).toBe("message_1");
    expect(capturedUrl).toBe("https://graph.instagram.com/v25.0/ig_account/messages");
    expect(JSON.parse(capturedBody)).toEqual({
      recipient: { id: "user_1" },
      message: { text: "Привет" },
    });
  });

  test("sends public replies to comments", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const client = new MetaGraphClient(config(), async (url, init) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ id: "public_reply_1" }));
    });

    const response = await client.sendPublicReply("comment_1", "Привет");

    expect(response.id).toBe("public_reply_1");
    expect(capturedUrl).toBe("https://graph.instagram.com/v25.0/comment_1/replies");
    expect(JSON.parse(capturedBody)).toEqual({ message: "Привет" });
  });

  test("checks for existing conversations with a commenter", async () => {
    let capturedUrl = "";
    const client = new MetaGraphClient(config(), async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ data: [{ id: "conversation_1" }] }));
    });

    const exists = await client.hasConversationWithUser("igsid_1");

    expect(exists).toBe(true);
    expect(capturedUrl).toBe(
      "https://graph.instagram.com/v25.0/ig_account/conversations?user_id=igsid_1",
    );
  });

  test("maps retryable Meta errors", async () => {
    const client = new MetaGraphClient(config(), async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Rate limit",
            code: 4,
            fbtrace_id: "trace",
          },
        }),
        { status: 429 },
      ),
    );

    await expect(client.sendPrivateReply("comment_1", "Привет")).rejects.toThrow(MetaApiError);
    try {
      await client.sendPrivateReply("comment_1", "Привет");
    } catch (error) {
      expect(error).toBeInstanceOf(MetaApiError);
      expect((error as MetaApiError).retryable).toBe(true);
      expect((error as MetaApiError).fbtraceId).toBe("trace");
    }
  });
});

function config() {
  return defaultAppConfig();
}
