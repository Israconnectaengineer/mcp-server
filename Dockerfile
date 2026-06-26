# ── Stage 1: Build ─────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN node --max-old-space-size=4096 node_modules/.bin/tsc --skipLibCheck || true
# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 \
    libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 \
    libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 \
    libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
    libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    lsb-release wget xdg-utils chromium \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/session
VOLUME ["/app/session"]
EXPOSE 3000
ENV NODE_ENV=production \
    PORT=3000 \
    SESSION_PATH=/app/session \
    WEBHOOK_URL="" \
    WEBHOOK_SECRET=""
CMD ["node", "dist/index.js"]