FROM node:22-bookworm-slim

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
