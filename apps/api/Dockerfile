# Image production của API (NestJS, kèm worker pg-boss). Build từ gốc repo:
#   docker build -f apps/api/Dockerfile -t teamlens-api .
# Khi chạy: áp migration còn thiếu rồi mới khởi động API (deploy/docker-compose.yml).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @teamlens/api...
COPY packages/schema packages/schema
COPY apps/api apps/api
RUN pnpm --filter @teamlens/api build
# Gói chạy độc lập: dist + drizzle + node_modules production (có @teamlens/schema).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @teamlens/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/drizzle /out/

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# `migrate.js` đặt exit code khác 0 khi lỗi, nên API không khởi động trên DB chưa migrate xong.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/main.js"]
