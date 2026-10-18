# syntax=docker/dockerfile:1

# ── Build: the web app (dist/) and the server (dist-server/) ───────────────────────────────
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && find dist -name "*.map" -delete
# Only what the server needs at run time: hono, its node adapter and openid-client.
RUN pnpm prune --prod

# ── Run ────────────────────────────────────────────────────────────────────────────────────
FROM node:22-slim
# The runtime needs only `node`. Apply the OS's security updates, and drop npm, corepack and yarn:
# nothing here runs them, and their bundled packages are the image's only Node findings in a scan.
RUN apt-get update \
 && apt-get -y --no-install-recommends upgrade \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/dist
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist-server/main.js"]
