import { describe, expect, it } from "vitest";
import { handleMcp } from "@/modules/agents/mcp";

describe("MCP perimeter", () => {
  it("rejects an oversized declared body before authentication", async () => {
    const response = await handleMcp(new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: { "content-length": String(256 * 1024 + 1), host: "localhost:3000" },
      body: "{}",
    }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: expect.objectContaining({ message: expect.stringContaining("256 KiB") }) }));
  });
});
