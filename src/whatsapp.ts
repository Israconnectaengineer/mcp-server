import { Client, LocalAuth, Message, Chat, Contact } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { EventEmitter } from "events";
import { readdir, rm } from "fs/promises";
import path from "path";

export interface ChatInfo {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessage?: string;
  timestamp?: number;
}

export interface MessageInfo {
  id: string;
  body: string;
  from: string;
  to: string;
  timestamp: number;
  fromMe: boolean;
  author?: string;
}

export interface ContactInfo {
  id: string;
  name: string;
  pushname?: string;
  number?: string;
  isMyContact: boolean;
}

export class WhatsAppManager extends EventEmitter {
  private client: Client;
  private isReady: boolean = false;
  private qrCode: string | null = null;
  private sessionPath: string;

  constructor(sessionPath: string = "./session") {
    super();
    this.sessionPath = sessionPath;

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: this.sessionPath,
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-sync",
          "--disable-translate",
          "--hide-scrollbars",
          "--metrics-recording-only",
          "--mute-audio",
          "--safebrowsing-disable-auto-update",
        ],
      },
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on("qr", (qr: string) => {
      this.qrCode = qr;
      console.log("\n📱 WhatsApp QR Code — scan with your phone:\n");
      qrcode.generate(qr, { small: true });
      console.log("\n⏳ Waiting for QR scan...\n");
      this.emit("qr", qr);
    });

    this.client.on("ready", () => {
      this.isReady = true;
      this.qrCode = null;
      console.log("✅ WhatsApp client is ready!");
      this.emit("ready");
    });

    this.client.on("authenticated", () => {
      console.log("🔐 WhatsApp authenticated successfully");
      this.emit("authenticated");
    });

    this.client.on("auth_failure", (msg: string) => {
      console.error("❌ WhatsApp authentication failed:", msg);
      this.isReady = false;
      this.emit("auth_failure", msg);
    });

    this.client.on("disconnected", (reason: string) => {
      console.warn("⚠️  WhatsApp disconnected:", reason);
      this.isReady = false;
      this.emit("disconnected", reason);
    });

    this.client.on("message", (msg: Message) => {
      this.emit("message", msg);
    });
  }

  async initialize(): Promise<void> {
    console.log("🚀 Initializing WhatsApp client...");
    await this.cleanupStaleChromiumLocks();
    await this.client.initialize();
  }

  private async cleanupStaleChromiumLocks(): Promise<void> {
    const lockNames = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket"]);

    const walkAndClean = async (dir: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
      try {
        entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walkAndClean(fullPath);
          continue;
        }

        if (lockNames.has(entry.name)) {
          try {
            // Remove file/symlink/socket lock artifacts left by crashed Chromium.
            await rm(fullPath, { force: true, recursive: false });
            console.log(`🧹 Removed stale Chromium lock: ${fullPath}`);
          } catch {
            // Ignore cleanup failures; Chromium launch will report if lock persists.
          }
        }
      }
    };

    await walkAndClean(this.sessionPath);
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  isClientReady(): boolean {
    return this.isReady;
  }

  private ensureReady(): void {
    if (!this.isReady) {
      throw new Error(
        "WhatsApp client is not ready. Please scan the QR code first."
      );
    }
  }

  async readChats(contactName?: string, limit: number = 20): Promise<ChatInfo[]> {
    this.ensureReady();

    const chats: Chat[] = await this.client.getChats();
    let filtered = chats;

    if (contactName) {
      const query = contactName.toLowerCase();
      filtered = chats.filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.id.user.includes(query)
      );
    }

    const limited = filtered.slice(0, limit);

    return limited.map((chat) => ({
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      lastMessage: (chat as any).lastMessage?.body ?? undefined,
      timestamp: (chat as any).lastMessage?.timestamp ?? undefined,
    }));
  }

  async sendMessage(recipientId: string, messageBody: string): Promise<MessageInfo> {
    this.ensureReady();

    // Normalize ID — accept plain numbers or full serialized IDs
    const chatId = recipientId.includes("@")
      ? recipientId
      : `${recipientId}@c.us`;

    const sentMsg: Message = await this.client.sendMessage(chatId, messageBody);

    return {
      id: sentMsg.id._serialized,
      body: sentMsg.body,
      from: sentMsg.from,
      to: sentMsg.to,
      timestamp: sentMsg.timestamp,
      fromMe: sentMsg.fromMe,
    };
  }

  async searchMessages(query: string): Promise<MessageInfo[]> {
    this.ensureReady();

    const chats: Chat[] = await this.client.getChats();
    const results: MessageInfo[] = [];
    const lowerQuery = query.toLowerCase();

    for (const chat of chats.slice(0, 30)) {
      try {
        const messages: Message[] = await chat.fetchMessages({ limit: 50 });
        for (const msg of messages) {
          if (
            msg.body &&
            msg.body.toLowerCase().includes(lowerQuery)
          ) {
            results.push({
              id: msg.id._serialized,
              body: msg.body,
              from: msg.from,
              to: msg.to,
              timestamp: msg.timestamp,
              fromMe: msg.fromMe,
              author: msg.author ?? undefined,
            });
          }
        }
      } catch {
        // Some chats may not support message fetching — skip silently
      }
    }

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  async listContacts(): Promise<ContactInfo[]> {
    this.ensureReady();

    const contacts: Contact[] = await this.client.getContacts();

    return contacts
      .filter((c) => !c.isMe && (c.name || c.pushname))
      .map((c) => ({
        id: c.id._serialized,
        name: c.name || c.pushname || c.id.user,
        pushname: c.pushname ?? undefined,
        number: c.number ?? undefined,
        isMyContact: c.isMyContact,
      }));
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }
}
