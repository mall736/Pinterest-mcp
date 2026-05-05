import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { z } from "zod";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.pinterest.com/v5";
const TOKEN = process.env.PINTEREST_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("❌ PINTEREST_ACCESS_TOKEN env var is missing.");
  process.exit(1);
}

// ── API Client ────────────────────────────────────────────────────────────────

async function apiRequest(method, path, body, params) {
  const url = new URL(BASE_URL + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url.toString(), options);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Auth failed. Check your PINTEREST_ACCESS_TOKEN.");
    if (res.status === 403) throw new Error(`Forbidden: ${err.message ?? "Insufficient scopes."}`);
    if (res.status === 404) throw new Error(`Not found: ${err.message ?? "Resource doesn't exist."}`);
    if (res.status === 429) throw new Error("Rate limit hit. Pinterest allows ~1000 calls/day. Wait and retry.");
    throw new Error(`Pinterest API ${res.status}: ${err.message ?? "Unknown error"}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

const get    = (path, params) => apiRequest("GET",    path, null, params);
const post   = (path, body)   => apiRequest("POST",   path, body);
const patch  = (path, body)   => apiRequest("PATCH",  path, body);
const del    = (path)         => apiRequest("DELETE", path);

// ── Helpers ───────────────────────────────────────────────────────────────────

const LIMIT = 50_000;

function cap(text) {
  if (text.length <= LIMIT) return text;
  return text.slice(0, LIMIT) + "\n\n[Truncated. Use pagination to see more.]";
}

function txt(text) {
  return { content: [{ type: "text", text: cap(text) }] };
}

function fmtBoard(b) {
  return [
    `### ${b.name} (ID: ${b.id})`,
    b.description  ? `**Description:** ${b.description}` : null,
    `**Privacy:** ${b.privacy}`,
    b.pin_count      != null ? `**Pins:** ${b.pin_count}` : null,
    b.follower_count != null ? `**Followers:** ${b.follower_count}` : null,
    b.owner?.username         ? `**Owner:** @${b.owner.username}` : null,
    b.created_at              ? `**Created:** ${new Date(b.created_at).toDateString()}` : null,
  ].filter(Boolean).join("\n");
}

function fmtPin(p) {
  const img = p.media?.images
    ? (p.media.images["400x300"]?.url ?? Object.values(p.media.images)[0]?.url)
    : null;
  return [
    `### ${p.title ?? "(No title)"} (ID: ${p.id})`,
    p.description ? `**Description:** ${p.description}` : null,
    p.link        ? `**Link:** ${p.link}` : null,
    p.board_id    ? `**Board ID:** ${p.board_id}` : null,
    p.alt_text    ? `**Alt text:** ${p.alt_text}` : null,
    img           ? `**Image:** ${img}` : null,
    p.created_at  ? `**Created:** ${new Date(p.created_at).toDateString()}` : null,
  ].filter(Boolean).join("\n");
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "pinterest-mcp-server", version: "1.0.0" });

// ── USER ──────────────────────────────────────────────────────────────────────

server.registerTool("pinterest_get_user", {
  title: "Get Pinterest User Profile",
  description: "Get the authenticated Pinterest user's profile: username, bio, board/pin counts.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => {
  const u = await get("/user_account");
  return txt([
    `## @${u.username}`,
    u.bio             ? `**Bio:** ${u.bio}` : null,
    `**Account:** ${u.account_type}`,
    u.board_count     != null ? `**Boards:** ${u.board_count}` : null,
    u.pin_count       != null ? `**Pins:** ${u.pin_count}` : null,
    u.follower_count  != null ? `**Followers:** ${u.follower_count}` : null,
    u.website_url     ? `**Website:** ${u.website_url}` : null,
  ].filter(Boolean).join("\n"));
});

// ── BOARDS ────────────────────────────────────────────────────────────────────

server.registerTool("pinterest_list_boards", {
  title: "List Pinterest Boards",
  description: "List all boards owned by the authenticated user. Supports pagination and privacy filter.",
  inputSchema: {
    page_size: z.number().int().min(1).max(100).default(25).describe("Items per page (max 100)"),
    bookmark:  z.string().optional().describe("Pagination cursor from previous response"),
    privacy:   z.enum(["PUBLIC","PROTECTED","SECRET"]).optional().describe("Filter by privacy level"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ page_size, bookmark, privacy }) => {
  const p = { page_size };
  if (bookmark) p.bookmark = bookmark;
  if (privacy)  p.privacy  = privacy;
  const data = await get("/boards", p);
  const list = data.items.map(fmtBoard).join("\n\n");
  const more = data.bookmark ? `\n\n> More available — bookmark: \`${data.bookmark}\`` : "";
  return txt(`## My Boards (${data.items.length})\n\n${list || "No boards found."}${more}`);
});

server.registerTool("pinterest_get_board", {
  title: "Get Pinterest Board",
  description: "Get details of a specific Pinterest board by ID.",
  inputSchema: {
    board_id: z.string().min(1).describe("Board ID"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ board_id }) => {
  const b = await get(`/boards/${board_id}`);
  return txt(fmtBoard(b));
});

server.registerTool("pinterest_create_board", {
  title: "Create Pinterest Board",
  description: "Create a new Pinterest board.",
  inputSchema: {
    name:        z.string().min(1).max(180).describe("Board name"),
    description: z.string().max(500).optional().describe("Board description"),
    privacy:     z.enum(["PUBLIC","PROTECTED","SECRET"]).default("PUBLIC").describe("Privacy level"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ name, description, privacy }) => {
  const body = { name, privacy };
  if (description) body.description = description;
  const b = await post("/boards", body);
  return txt(`✅ Board created!\n\n${fmtBoard(b)}`);
});

server.registerTool("pinterest_update_board", {
  title: "Update Pinterest Board",
  description: "Update the name, description, or privacy of an existing board.",
  inputSchema: {
    board_id:    z.string().min(1).describe("Board ID to update"),
    name:        z.string().min(1).max(180).optional().describe("New name"),
    description: z.string().max(500).optional().describe("New description"),
    privacy:     z.enum(["PUBLIC","PROTECTED","SECRET"]).optional().describe("New privacy level"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ board_id, name, description, privacy }) => {
  const body = {};
  if (name        !== undefined) body.name        = name;
  if (description !== undefined) body.description = description;
  if (privacy     !== undefined) body.privacy     = privacy;
  if (!Object.keys(body).length) return txt("Nothing to update. Provide name, description, or privacy.");
  const b = await patch(`/boards/${board_id}`, body);
  return txt(`✅ Board updated!\n\n${fmtBoard(b)}`);
});

server.registerTool("pinterest_delete_board", {
  title: "Delete Pinterest Board",
  description: "⚠️ PERMANENTLY delete a board and all its pins. Irreversible.",
  inputSchema: {
    board_id: z.string().min(1).describe("Board ID to delete"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async ({ board_id }) => {
  await del(`/boards/${board_id}`);
  return txt(`✅ Board ${board_id} permanently deleted.`);
});

server.registerTool("pinterest_list_board_sections", {
  title: "List Board Sections",
  description: "List all named sections within a Pinterest board.",
  inputSchema: {
    board_id:  z.string().min(1).describe("Board ID"),
    page_size: z.number().int().min(1).max(100).default(25).describe("Items per page"),
    bookmark:  z.string().optional().describe("Pagination cursor"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ board_id, page_size, bookmark }) => {
  const p = { page_size };
  if (bookmark) p.bookmark = bookmark;
  const data = await get(`/boards/${board_id}/sections`, p);
  const list = data.items.map(s => `- **${s.name}** (ID: ${s.id})`).join("\n");
  const more = data.bookmark ? `\n\n> More — bookmark: \`${data.bookmark}\`` : "";
  return txt(`## Sections (${data.items.length})\n\n${list || "No sections."}${more}`);
});

server.registerTool("pinterest_create_board_section", {
  title: "Create Board Section",
  description: "Add a named section to an existing Pinterest board.",
  inputSchema: {
    board_id: z.string().min(1).describe("Board ID"),
    name:     z.string().min(1).max(180).describe("Section name"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ board_id, name }) => {
  const s = await post(`/boards/${board_id}/sections`, { name });
  return txt(`✅ Section created!\n- **${s.name}** (ID: ${s.id})`);
});

// ── PINS ──────────────────────────────────────────────────────────────────────

server.registerTool("pinterest_list_pins", {
  title: "List Pinterest Pins",
  description: "List pins owned by the user. Optionally filter by board.",
  inputSchema: {
    page_size: z.number().int().min(1).max(100).default(25).describe("Items per page"),
    bookmark:  z.string().optional().describe("Pagination cursor"),
    board_id:  z.string().optional().describe("Filter by board ID"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ page_size, bookmark, board_id }) => {
  const p = { page_size };
  if (bookmark) p.bookmark = bookmark;
  if (board_id) p.board_id = board_id;
  const data = await get("/pins", p);
  const list = data.items.map(fmtPin).join("\n\n---\n\n");
  const more = data.bookmark ? `\n\n> More — bookmark: \`${data.bookmark}\`` : "";
  return txt(`## Pins (${data.items.length})\n\n${list || "No pins found."}${more}`);
});

server.registerTool("pinterest_list_board_pins", {
  title: "List Pins on a Board",
  description: "List all pins saved to a specific Pinterest board.",
  inputSchema: {
    board_id:  z.string().min(1).describe("Board ID"),
    page_size: z.number().int().min(1).max(100).default(25).describe("Items per page"),
    bookmark:  z.string().optional().describe("Pagination cursor"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ board_id, page_size, bookmark }) => {
  const p = { page_size };
  if (bookmark) p.bookmark = bookmark;
  const data = await get(`/boards/${board_id}/pins`, p);
  const list = data.items.map(fmtPin).join("\n\n---\n\n");
  const more = data.bookmark ? `\n\n> More — bookmark: \`${data.bookmark}\`` : "";
  return txt(`## Board ${board_id} Pins (${data.items.length})\n\n${list || "No pins."}${more}`);
});

server.registerTool("pinterest_get_pin", {
  title: "Get Pinterest Pin",
  description: "Get full details of a specific Pinterest pin by ID.",
  inputSchema: {
    pin_id: z.string().min(1).describe("Pin ID"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ pin_id }) => {
  const p = await get(`/pins/${pin_id}`);
  return txt(fmtPin(p));
});

server.registerTool("pinterest_create_pin", {
  title: "Create Pinterest Pin",
  description: "Create a new pin on a board using an image URL.",
  inputSchema: {
    board_id:         z.string().min(1).describe("Target board ID"),
    image_url:        z.string().url().describe("Public image URL to pin"),
    title:            z.string().max(100).optional().describe("Pin title"),
    description:      z.string().max(800).optional().describe("Pin description"),
    link:             z.string().url().optional().describe("Destination URL when clicked"),
    alt_text:         z.string().max(500).optional().describe("Image alt text"),
    board_section_id: z.string().optional().describe("Section ID within the board"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ board_id, image_url, title, description, link, alt_text, board_section_id }) => {
  const body = { board_id, media_source: { source_type: "image_url", url: image_url } };
  if (title)            body.title            = title;
  if (description)      body.description      = description;
  if (link)             body.link             = link;
  if (alt_text)         body.alt_text         = alt_text;
  if (board_section_id) body.board_section_id = board_section_id;
  const p = await post("/pins", body);
  return txt(`✅ Pin created!\n\n${fmtPin(p)}`);
});

server.registerTool("pinterest_save_pin", {
  title: "Save / Re-pin a Pin",
  description: "Save an existing pin to one of your boards (re-pin).",
  inputSchema: {
    pin_id:           z.string().min(1).describe("Pin ID to save"),
    board_id:         z.string().min(1).describe("Target board ID"),
    board_section_id: z.string().optional().describe("Target section (optional)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ pin_id, board_id, board_section_id }) => {
  const body = { board_id, media_source: { source_type: "pin_url", pin_id } };
  if (board_section_id) body.board_section_id = board_section_id;
  const p = await post("/pins", body);
  return txt(`✅ Pin saved!\n\n${fmtPin(p)}`);
});

server.registerTool("pinterest_update_pin", {
  title: "Update Pinterest Pin",
  description: "Update a pin's title, description, link, or move it to another board.",
  inputSchema: {
    pin_id:           z.string().min(1).describe("Pin ID"),
    title:            z.string().max(100).optional().describe("New title"),
    description:      z.string().max(800).optional().describe("New description"),
    link:             z.string().url().optional().describe("New destination URL"),
    alt_text:         z.string().max(500).optional().describe("New alt text"),
    board_id:         z.string().optional().describe("Move to this board"),
    board_section_id: z.string().optional().describe("Move to this section"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ pin_id, ...fields }) => {
  const body = Object.fromEntries(Object.entries(fields).filter(([,v]) => v !== undefined));
  if (!Object.keys(body).length) return txt("Nothing to update.");
  const p = await patch(`/pins/${pin_id}`, body);
  return txt(`✅ Pin updated!\n\n${fmtPin(p)}`);
});

server.registerTool("pinterest_delete_pin", {
  title: "Delete Pinterest Pin",
  description: "⚠️ PERMANENTLY delete a pin. Irreversible.",
  inputSchema: {
    pin_id: z.string().min(1).describe("Pin ID to delete"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async ({ pin_id }) => {
  await del(`/pins/${pin_id}`);
  return txt(`✅ Pin ${pin_id} permanently deleted.`);
});

server.registerTool("pinterest_search_pins", {
  title: "Search Pinterest Pins",
  description: "Search Pinterest pins by keyword.",
  inputSchema: {
    query:     z.string().min(1).max(200).describe("Search keywords e.g. 'minimal interior'"),
    page_size: z.number().int().min(1).max(100).default(25).describe("Items per page"),
    bookmark:  z.string().optional().describe("Pagination cursor"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ query, page_size, bookmark }) => {
  const p = { query, page_size };
  if (bookmark) p.bookmark = bookmark;
  const data = await get("/search/pins/", p);
  const list = data.items.map(fmtPin).join("\n\n---\n\n");
  const more = data.bookmark ? `\n\n> More — bookmark: \`${data.bookmark}\`` : "";
  return txt(`## Results for "${query}" (${data.items.length})\n\n${list || "Nothing found."}${more}`);
});

// ── Transport ─────────────────────────────────────────────────────────────────

const TRANSPORT = process.env.TRANSPORT ?? "http";

if (TRANSPORT === "http") {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "pinterest-mcp-server", version: "1.0.0" });
  });

  const port = parseInt(process.env.PORT ?? "3000");
  app.listen(port, () => console.log(`✅ Pinterest MCP running on port ${port}`));
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Pinterest MCP running on stdio");
}
