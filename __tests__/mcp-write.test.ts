import { describe, expect, it, vi } from "vitest";

const { create, update } = vi.hoisted(() => ({ create: vi.fn(async (_w: string, d: unknown) => d), update: vi.fn(async () => ({})) }));
vi.mock("@/lib/campaigns/mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/campaigns/mutations")>()),
  createCampaign: create,
  updateCampaign: update,
}));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { callTool, listTools } from "../lib/integrations/mcp";

const context = { workspaceId: "ws_1", keyId: "key_1", scopes: ["campaigns:read"] };
const campaign = { name: "Test", postId: "123", keywords: ["claude"], dmMessage: "hi" };

describe("MCP write tools", () => {
  it("creates campaigns paused by default, in the key workspace", async () => {
    await callTool(context, "create_campaign", campaign);
    expect(create).toHaveBeenCalledWith("ws_1", expect.objectContaining({ isActive: false, name: "Test" }));
  });

  it("advertises the paused default to clients", () => {
    const create = listTools(context).find(tool => tool.name === "create_campaign");
    expect((create?.inputSchema as { properties: { isActive: { default: boolean } } }).properties.isActive.default).toBe(false);
  });

  it("rejects invalid input with the reason", async () => {
    await expect(callTool(context, "create_campaign", { ...campaign, keywords: [] }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("keyword") });
  });

  it("set_campaign_active only changes isActive", async () => {
    await callTool(context, "set_campaign_active", { id: "c1", isActive: true });
    expect(update).toHaveBeenCalledWith("ws_1", "c1", { isActive: true });
  });
});
