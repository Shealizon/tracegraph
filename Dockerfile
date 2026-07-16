FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=8787 \
    PAPER_GRAPH_DATA=/app/server-data \
    CODEX_ENABLED=0
VOLUME ["/app/server-data"]
EXPOSE 8787
CMD ["npm", "start"]
