import { describe, expect, test } from "bun:test";
import { hmacSha256Hex, verifyInstagramSignature } from "../src/webhook/signature";

describe("Instagram webhook signature", () => {
  test("accepts valid sha256 signature", async () => {
    const body = JSON.stringify({ object: "instagram" });
    const signature = `sha256=${await hmacSha256Hex(body, "secret")}`;

    expect(await verifyInstagramSignature(body, signature, "secret")).toBe(true);
  });

  test("rejects invalid signature", async () => {
    const body = JSON.stringify({ object: "instagram" });

    expect(await verifyInstagramSignature(body, "sha256=bad", "secret")).toBe(false);
  });
});
