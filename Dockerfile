# Both stages pinned to Node 26.12.1, the 2026-10-21 security release (CVE-2026-106069 and others).
FROM node:26.12.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:26.12.1-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 SHARE_DIR=/data/shares
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/shares /data/events && chown node:node /data/shares /data/events
USER node
VOLUME /data/shares /data/events
EXPOSE 8080
CMD ["node", "server/index.ts"]
