import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import OpenAI from "openai";
import { WhatsAppManager } from "./whatsapp.js";

const SESSION_PATH = process.env.SESSION_PATH ?? "./session";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT
  ?? "You are a helpful WhatsApp assistant. Reply in the same language the user messages you in. Keep replies concise and friendly.";

// ─── OpenAI client (only if API key is set) ──────────────────────────────────
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
if (!openai) console.warn("⚠️  OPENAI_API_KEY not set — AI auto-reply is disabled");

// ─── WhatsApp client ────────────────────────────────────────────────────────
const wa = new WhatsAppManager(SESSION_PATH);

// ─── MCP Server ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "whatsapp-mcp-server",
  version: "1.0.0",
});

// Tool: read_chats
server.tool(
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
      .default(20)
      .describe("Maximum number of chats to return (default 20, max 100)"),
  },
  async ({ contact_name, limit }) => {
    try {
      const chats = await wa.readChats(contact_name, limit);
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
server.tool(
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
  async ({ recipient_id, message_body }) => {
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
server.tool(
  "search_messages",
  "Search across WhatsApp messages for a specific keyword or phrase",
  {
    query: z
      .string()
      .describe("Search term to look for in message bodies"),
  },
  async ({ query }) => {
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
server.tool(
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

// ─── REST: send-message (Poke calls this after AI generates reply) ──────────
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

app.get("/sse", async (req: Request, res: Response) => {
  console.log("📡 SSE connection established from", req.ip);
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    console.log("📡 SSE connection closed:", transport.sessionId);
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
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
    console.log(`   Send Msg:     http://localhost:${PORT}/send-message  ← Poke posts AI reply here`);
    console.log(`   Webhook fwd:  ${WEBHOOK_URL || "(not set — WEBHOOK_URL env is empty)"}\n`);
  });

  // Handle every incoming WhatsApp message
  wa.on("message", async (msg: any) => {
    if (msg.fromMe) return; // ignore our own sent messages

    console.log(`📩 Incoming from ${msg.from}: "${String(msg.body ?? "").slice(0, 80)}"`);

    // ── AI Auto-reply ────────────────────────────────────────────────────────
    if (openai && msg.body) {
      try {
        console.log(`🤖 Generating AI reply for ${msg.from}...`);
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: AI_SYSTEM_PROMPT },
            { role: "user",   content: msg.body },
          ],
        });
        const reply = completion.choices[0]?.message?.content;
        if (reply) {
          await wa.sendMessage(msg.from, reply);
          console.log(`✅ AI reply sent to ${msg.from}: "${reply.slice(0, 80)}"`);
        }
      } catch (err) {
        console.error("❌ OpenAI error:", (err as Error).message);
      }
    } else if (!openai) {
      console.warn("⚠️  No OPENAI_API_KEY — skipping auto-reply");
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
