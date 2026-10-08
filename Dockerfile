# Focus DNS server (packages/dns-server). Build from the repo root:
#   docker build -t focus-dns .
# See packages/dns-server/README.md#docker.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/site-blocker/package.json packages/site-blocker/
COPY packages/dns-server/package.json packages/dns-server/
RUN npm ci --workspace @focus/site-blocker --workspace @focus/dns-server
COPY packages/site-blocker packages/site-blocker
COPY packages/dns-server packages/dns-server
RUN npm run build:dns

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
COPY package.json package-lock.json ./
COPY packages/site-blocker/package.json packages/site-blocker/
COPY packages/dns-server/package.json packages/dns-server/
RUN npm ci --omit=dev --workspace @focus/dns-server && npm cache clean --force
COPY --from=build /app/packages/site-blocker/dist packages/site-blocker/dist
COPY --from=build /app/packages/dns-server/dist packages/dns-server/dist
COPY packages/dns-server/public packages/dns-server/public
RUN mkdir -p /data && chown node:node /data
# Docker lets unprivileged users bind low ports inside the container's network namespace.
USER node
VOLUME /data
EXPOSE 53/udp 53/tcp 8080/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.DASHBOARD_PORT || 8080) + '/api/status').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "packages/dns-server/dist/main.js"]
