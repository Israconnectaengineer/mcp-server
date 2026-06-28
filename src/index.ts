import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import { WhatsAppManager } from "./whatsapp.js";

const SESSION_PATH = process.env.SESSION_PATH ?? "./session";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
const POKE_API_KEY = process.env.POKE_API_KEY ?? "";
const POKE_API_URL = process.env.POKE_API_URL
  ?? "https://poke.com/api/v1/inbound/api-message";

if (!POKE_API_KEY) {
  console.warn("⚠️  POKE_API_KEY not set — AI auto-reply is disabled");
}

// ─── WhatsApp client ────────────────────────────────────────────────────────
const wa = new WhatsAppManager(SESSION_PATH);

// ─── MCP Server ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "whatsapp-mcp-server",
  version: "1.0.0",
});
const registerTool = (server.tool as any).bind(server) as (...args: any[]) => void;

// Tool: read_chats
registerTool(
  "read_chats",
  "Retrieve recent WhatsApp chats, optionally filtered by contact name",
  {
    contact_name: z
      .string()
      .optional()
      .describe("Partial name of the contact/group to filter chats by"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of chats to return (default 20, max 100)"),
  },
  async ({ contact_name, limit }: { contact_name?: string; limit?: number }) => {
    try {
      const chats = await wa.readChats(contact_name, limit ?? 20);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ chats, total: chats.length }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: send_message
registerTool(
  "send_message",
  "Send a WhatsApp message to a contact or group",
  {
    recipient_id: z
      .string()
      .describe(
        "Recipient's WhatsApp ID (e.g. 923001234567@c.us) or plain number (e.g. 923001234567)"
      ),
    message_body: z.string().describe("Text content of the message to send"),
  },
  async ({ recipient_id, message_body }: { recipient_id: string; message_body: string }) => {
    try {
      const sent = await wa.sendMessage(recipient_id, message_body);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { success: true, message: sent },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: search_messages
registerTool(
  "search_messages",
  "Search across WhatsApp messages for a specific keyword or phrase",
  {
    query: z
      .string()
      .describe("Search term to look for in message bodies"),
  },
  async ({ query }: { query: string }) => {
    try {
      const messages = await wa.searchMessages(query);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { messages, total: messages.length },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: list_contacts
registerTool(
  "list_contacts",
  "List all WhatsApp contacts with their IDs and display names",
  {},
  async () => {
    try {
      const contacts = await wa.listContacts();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { contacts, total: contacts.length },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ─── Express / SSE transport ─────────────────────────────────────────────────
const app = express();
app.use(express.json());

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

async function forwardToPokeForToolReply(input: {
  from: string;
  body: string;
  messageId: string;
  timestamp?: number;
  author?: string;
}): Promise<void> {
  if (!POKE_API_KEY) {
    throw new Error("POKE_API_KEY is not configured");
  }

  const instruction = [
    "Incoming WhatsApp message requires a direct reply.",
    `Sender WhatsApp ID: ${input.from}`,
    `Message ID: ${input.messageId}`,
    `Message Body: ${input.body}`,
    "",
    "Required action:",
    "1) Write a helpful response to the user message.",
    `2) Call MCP tool send_message with recipient_id exactly '${input.from}'.`,
    "3) Put your drafted response in message_body when calling the tool.",
    "4) Do not call inbound/api-message again.",
  ].join("\n");

  const response = await fetch(POKE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${POKE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: instruction,
      source: "whatsapp-mcp-server",
      whatsapp: {
        from: input.from,
        messageId: input.messageId,
        body: input.body,
        timestamp: input.timestamp ?? null,
        author: input.author ?? null,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Poke API error ${response.status}: ${errorText.slice(0, 300)}`
    );
  }

  const ackBody = (await response.json()) as JsonValue;
  console.log(`✅ Poke accepted inbound message: ${JSON.stringify(ackBody)}`);
}

function shouldForwardMessageToPoke(msg: { from?: string; body?: string; fromMe?: boolean }): {
  ok: boolean;
  reason?: string;
} {
  if (msg.fromMe) return { ok: false, reason: "from_me" };

  const from = String(msg.from ?? "");
  const body = String(msg.body ?? "").trim();

  if (!body) return { ok: false, reason: "empty_body" };
  if (from === "status@broadcast") return { ok: false, reason: "status_broadcast" };
  if (from.endsWith("@newsletter")) return { ok: false, reason: "newsletter" };

  // Allow direct users and groups. For unknown formats, skip to avoid bad recipient IDs.
  const isDirect = from.endsWith("@c.us") || from.endsWith("@lid");
  const isGroup = from.endsWith("@g.us");
  if (!isDirect && !isGroup) return { ok: false, reason: "unsupported_chat_type" };

  return { ok: true };
}

// Health + status endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    whatsapp: {
      ready: wa.isClientReady(),
      qrPending: wa.getQRCode() !== null,
    },
  });
});

// QR code endpoint (handy for headless setups)
app.get("/qr", (_req: Request, res: Response) => {
  const qr = wa.getQRCode();
  if (!qr) {
    if (wa.isClientReady()) {
      res.json({ status: "authenticated", qr: null });
    } else {
      res.status(503).json({ status: "not_ready", qr: null });
    }
    return;
  }
  res.json({ status: "pending", qr });
});

// ─── REST: send-message (manual/optional endpoint to send WA message) ───────
app.post("/send-message", async (req: Request, res: Response) => {
  console.log("📨 /send-message called — body:", JSON.stringify(req.body));

  if (WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
    console.warn("⛔ /send-message rejected — bad or missing x-webhook-secret header");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { recipient_id, message_body } = req.body as {
    recipient_id?: string;
    message_body?: string;
  };
  if (!recipient_id || !message_body) {
    console.warn("⛔ /send-message missing fields — got:", req.body);
    res.status(400).json({ error: "recipient_id and message_body are required" });
    return;
  }
  try {
    console.log(`📤 Sending to ${recipient_id}: "${message_body.slice(0, 60)}..."`)
    const sent = await wa.sendMessage(recipient_id, message_body);
    console.log("✅ Message sent:", sent.id);
    res.json({ success: true, message: sent });
  } catch (err) {
    console.error("❌ sendMessage failed:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// SSE transport — Poke registers this URL
const transports: Map<string, SSEServerTransport> = new Map();
let hasActiveMcpTransport = false;

app.get("/sse", async (req: Request, res: Response) => {
  if (hasActiveMcpTransport) {
    res.status(409).json({ error: "MCP SSE transport already connected" });
    return;
  }

  console.log("📡 SSE connection established from", req.ip);
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  hasActiveMcpTransport = true;

  res.on("close", () => {
    console.log("📡 SSE connection closed:", transport.sessionId);
    transports.delete(transport.sessionId);
    hasActiveMcpTransport = false;
  });

  try {
    await server.connect(transport);
  } catch (err) {
    console.error("❌ SSE connect error:", (err as Error).message);
    transports.delete(transport.sessionId);
    hasActiveMcpTransport = false;
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to connect MCP transport" });
    } else {
      res.end();
    }
  }
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// ─── Startup ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("   WhatsApp MCP Server for Poke");
  console.log("═══════════════════════════════════════════════");

  // Start Express first so /health is reachable during WA init
  app.listen(PORT, () => {
    console.log(`\n🌐 HTTP server listening on port ${PORT}`);
    console.log(`   Health:   http://localhost:${PORT}/health`);
    console.log(`   QR Code:  http://localhost:${PORT}/qr`);
    console.log(`   SSE URL:      http://localhost:${PORT}/sse  ← register in Poke`);
    console.log(`   Send Msg:     http://localhost:${PORT}/send-message  ← optional/manual endpoint`);
    console.log(`   Poke API:     ${POKE_API_URL}`);
    console.log(`   Webhook fwd:  ${WEBHOOK_URL || "(not set — WEBHOOK_URL env is empty)"}\n`);
  });

  // Handle every incoming WhatsApp message
  wa.on("message", async (msg: any) => {
    const gate = shouldForwardMessageToPoke(msg);
    if (!gate.ok) {
      console.log(`⏭️ Skipping inbound message (${gate.reason ?? "filtered"}) from ${String(msg?.from ?? "unknown")}`);
      return;
    }

    console.log(`📩 Incoming from ${msg.from}: "${String(msg.body ?? "").slice(0, 80)}"`);

    // ── AI auto-reply via Poke + MCP send_message tool ──────────────────────
    if (msg.body && msg.body.trim().length > 0) {
      if (!POKE_API_KEY) {
        console.warn("⚠️  No POKE_API_KEY — skipping auto-reply");
      } else {
        try {
          console.log(`🤖 Forwarding message to Poke for tool-based reply: ${msg.from}`);
          await forwardToPokeForToolReply({
            from: msg.from,
            body: msg.body,
            messageId: msg.id._serialized,
            timestamp: msg.timestamp,
            author: msg.author ?? undefined,
          });
        } catch (err) {
          console.error("❌ Poke AI error:", (err as Error).message);
        }
      }
    }

    // ── Also forward to webhook if set (optional) ────────────────────────────
    if (WEBHOOK_URL) {
      try {
        const payload = {
          id: msg.id._serialized,
          body: msg.body,
          from: msg.from,
          to: msg.to,
          timestamp: msg.timestamp,
          fromMe: msg.fromMe,
          author: msg.author ?? undefined,
        };
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (WEBHOOK_SECRET) headers["x-webhook-secret"] = WEBHOOK_SECRET;
        const response = await fetch(WEBHOOK_URL, { method: "POST", headers, body: JSON.stringify(payload) });
        if (!response.ok) console.error(`⚠️  Webhook responded ${response.status}`);
      } catch (err) {
        console.error("❌ Webhook forward error:", (err as Error).message);
      }
    }
  });

  // Initialise WhatsApp
  wa.on("ready", () => {
    console.log("\n🎉 WhatsApp ready — MCP tools are live!\n");
  });

  await wa.initialize();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
