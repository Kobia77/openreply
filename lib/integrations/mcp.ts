import { z } from "zod";
import { getCampaign, getCampaignStats, listCampaigns } from "./campaigns";
import { requireScope, type ServiceContext } from "./auth";
import { ApiError } from "./http";
import {
  CampaignError,
  createAutomationSchema,
  createCampaign,
  deleteCampaign,
  updateAutomationSchema,
  updateCampaign,
} from "@/lib/campaigns/mutations";
import { duplicateCampaign } from "@/lib/campaigns/duplicate";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { createInstagramContext, getUserMedia } from "@/lib/instagram/provider";

const idOnly = z.object({ id: z.string().min(1).max(100) }).strict();
const noArgs = z.object({}).strict();
const recentPostsArgs = z.object({ limit: z.number().int().min(1).max(50).optional() }).strict();
const updateArgs = updateAutomationSchema.extend({ id: z.string().min(1).max(100) }).strict();
const setActiveArgs = z.object({ id: z.string().min(1).max(100), isActive: z.boolean() }).strict();

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input" });

// The shared schema defaults isActive to true (the dashboard creates live campaigns),
// but MCP creates paused ones, so the schema clients see must say so too.
const createInputSchema = (() => {
  const schema = json(createAutomationSchema) as { properties: Record<string, Record<string, unknown>> };
  schema.properties.isActive = { ...schema.properties.isActive, default: false };
  return schema;
})();

type Kind = "read" | "write" | "destructive";
const tools: { name: string; description: string; kind: Kind; inputSchema: unknown }[] = [
  { name: "list_campaigns", kind: "read", inputSchema: json(noArgs),
    description: "List up to 100 campaigns in this workspace; use get_campaign for complete settings and destination links." },
  { name: "get_campaign", kind: "read", inputSchema: json(idOnly),
    description: "Read campaign settings and ordered destination links. Missing links are null, not invented." },
  { name: "get_campaign_stats", kind: "read", inputSchema: json(idOnly),
    description: "Read aggregate send outcomes and raw link requests, not recipient conversions." },
  { name: "list_recent_posts", kind: "read", inputSchema: json(recentPostsArgs),
    description: "List recent Instagram posts of the connected account (id, caption, permalink). Use the id as postId when creating a campaign for a specific post." },
  { name: "create_campaign", kind: "write", inputSchema: createInputSchema,
    description: "Create a comment-to-DM campaign. Same fields and rules as the dashboard. Trigger: postId (from list_recent_posts), matchAnyPost or pendingNextReel. Needs keywords or matchAnyWord. Created PAUSED unless isActive is true." },
  { name: "update_campaign", kind: "write", inputSchema: json(updateArgs),
    description: "Change fields of a campaign by id. Only the fields you pass change. Empty string clears a destination URL." },
  { name: "set_campaign_active", kind: "write", inputSchema: json(setActiveArgs),
    description: "Turn a campaign on (isActive true) or off (false)." },
  { name: "duplicate_campaign", kind: "write", inputSchema: json(idOnly),
    description: "Copy a campaign with all its settings. The copy starts paused and gets ' copy' added to its name." },
  { name: "delete_campaign", kind: "destructive", inputSchema: json(idOnly),
    description: "Permanently delete a campaign by id. Cannot be undone; prefer set_campaign_active false to pause." },
];

export function listTools(context: ServiceContext) {
  if (!context.scopes.includes("campaigns:read")) return [];
  return tools.map(({ kind, ...tool }) => ({
    ...tool,
    annotations: {
      readOnlyHint: kind === "read",
      destructiveHint: kind === "destructive",
      idempotentHint: kind === "read",
      openWorldHint: false,
    },
  }));
}

function parse<T extends z.ZodType>(schema: T, args: unknown): z.infer<T> {
  const result = schema.safeParse(args);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new ApiError(`Invalid tool arguments: ${issues}`);
  }
  return result.data;
}

async function run(context: ServiceContext, name: string, args: unknown) {
  const { workspaceId } = context;
  switch (name) {
    case "list_campaigns":
      parse(noArgs, args);
      return listCampaigns(context);
    case "get_campaign":
      return getCampaign(context, parse(idOnly, args).id);
    case "get_campaign_stats":
      return getCampaignStats(context, parse(idOnly, args).id);
    case "list_recent_posts": {
      const { limit = 25 } = parse(recentPostsArgs, args);
      const account = await getWorkspaceInstagramAccount(workspaceId);
      if (!account) throw new ApiError("No Instagram account connected", 400);
      const posts = await getUserMedia({ context: await createInstagramContext(account), limit });
      return posts.map(p => ({
        id: p.id, caption: p.caption?.slice(0, 200) ?? null, permalink: p.permalink ?? null,
        timestamp: p.timestamp ?? null, mediaType: p.media_type ?? null,
      }));
    }
    case "create_campaign": {
      // Paused by default, so a campaign made from a chat never fires before it is reviewed.
      const input = args && typeof args === "object" ? { isActive: false, ...args } : args;
      return createCampaign(workspaceId, parse(createAutomationSchema, input));
    }
    case "update_campaign": {
      const { id, ...input } = parse(updateArgs, args);
      return updateCampaign(workspaceId, id, input);
    }
    case "set_campaign_active": {
      const { id, isActive } = parse(setActiveArgs, args);
      return updateCampaign(workspaceId, id, { isActive });
    }
    case "duplicate_campaign": {
      const copy = await duplicateCampaign({ automationId: parse(idOnly, args).id, workspaceId });
      if (!copy) throw new ApiError("Campaign not found", 404);
      return copy;
    }
    case "delete_campaign":
      return deleteCampaign(workspaceId, parse(idOnly, args).id);
    default:
      throw new ApiError("Unknown tool", 404);
  }
}

export async function callTool(context: ServiceContext, name: string, args: unknown) {
  requireScope(context, "campaigns:read");
  try {
    return await run(context, name, args);
  } catch (error) {
    if (error instanceof CampaignError) throw new ApiError(error.message, error.status);
    throw error;
  }
}
