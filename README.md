# WhatsApp MCP Server for Poke

A self-hosted Model Context Protocol (MCP) server that bridges **WhatsApp Web** to **Poke** via Server-Sent Events (SSE).

---

## Architecture

```
WhatsApp Web  ──(Puppeteer)──▶  whatsapp-web.js
                                      │
                                 WhatsAppManager
                                      │
                              MCP Tools (4 tools)
                                      │
                            Express SSE Transport
                                      │
                              http://localhost:3000/sse
                                      │
                                  ◀── Poke ──▶
```

**Stack:** Node.js · TypeScript · `@modelcontextprotocol/sdk` · `whatsapp-web.js` · Puppeteer · Docker

---

## Quick Start

### 1. Clone and build

```bash
git clone <your-repo>
cd whatsapp-mcp-server
docker compose up --build
```

### 2. Scan the QR code

Watch the container logs for a terminal QR code:

```bash
docker compose logs -f
```

Open WhatsApp on your phone → **Linked Devices** → **Link a Device** → scan the QR.

The session is saved in a Docker volume (`whatsapp_session`) and persists across restarts.

### 3. Verify the server is ready

```bash
curl http://localhost:3000/health
# {"status":"ok","whatsapp":{"ready":true,"qrPending":false}}
```

### 4. Register in Poke

1. Go to **https://poke.com/integrations/new**
2. Choose **MCP / SSE** integration
3. Enter the SSE URL:

   ```
   http://<your-server-ip>:3000/sse
   ```

4. Save. Poke will open the SSE stream and discover all four tools automatically.

---

## MCP Tools

| Tool | Description | Inputs |
|------|-------------|--------|
| `read_chats` | List recent chats | `contact_name?` (string), `limit?` (1–100, default 20) |
| `send_message` | Send a message | `recipient_id` (string), `message_body` (string) |
| `search_messages` | Search message bodies | `query` (string) |
| `list_contacts` | All contacts with IDs | _(none)_ |

### Recipient ID format

`send_message` accepts either:
- Full serialized ID: `923001234567@c.us`
- Plain international number: `923001234567`

---

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Liveness check + WA status |
| `/qr` | GET | Returns QR as JSON (for custom UIs) |
| `/sse` | GET | **SSE stream — register this in Poke** |
| `/messages?sessionId=` | POST | MCP message endpoint (used by SDK) |

---

## Configuration

Set via environment variables or edit `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `SESSION_PATH` | `/app/session` | WhatsApp session storage path |
| `NODE_ENV` | `production` | Node environment |

---

## Session Persistence

The WhatsApp session is stored in a named Docker volume:

```yaml
volumes:
  whatsapp_session:
    driver: local
```

To back it up:

```bash
docker run --rm \
  -v whatsapp-mcp-server_whatsapp_session:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/session-backup.tar.gz -C /data .
```

To restore:

```bash
docker run --rm \
  -v whatsapp-mcp-server_whatsapp_session:/data \
  -v $(pwd):/backup \
  alpine tar xzf /backup/session-backup.tar.gz -C /data
```

---

## Production Tips

- **Reverse proxy:** Put Nginx/Caddy in front with HTTPS so Poke connects over `https://yourdomain.com/sse`
- **Firewall:** Only expose port 3000 to trusted IPs or hide behind a reverse proxy
- **Logs:** `docker compose logs -f whatsapp-mcp` — structured JSON logs rotated at 10 MB × 3 files
- **Re-authentication:** If WhatsApp logs out, delete the session volume and restart to get a fresh QR

---

## Troubleshooting

**Container crashes with `error while loading shared libraries: libnss3.so`**
→ The Dockerfile installs `libnss3` automatically. Rebuild: `docker compose build --no-cache`

**QR not appearing in logs**
→ `docker compose logs -f` — give it 30–60 s to start Chromium

**`WhatsApp client is not ready`**
→ Hit `/health` to check status, then `/qr` to retrieve the current QR if pending

**Poke can't reach the SSE URL**
→ Make sure port 3000 is accessible from Poke's servers (check firewall / security groups)
