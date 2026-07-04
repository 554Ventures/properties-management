# Hearth API container (deployment plan §3/§4.4) — for Cloudflare Containers
# or any OCI runtime. Build from the repo root so the workspace is available:
#   docker build -f apps/api/Dockerfile -t hearth-api .
# Migrations are NOT run here — CI applies `prisma migrate deploy` against the
# database before this image is deployed (plan §6.1). The container only needs
# DATABASE_URL (+ the secrets in .env.example) at runtime.

FROM node:22-slim AS build
# openssl so Prisma's engine detection sees the same libssl as the runtime
# stage (binaryTargets in schema.prisma pins the engines regardless).
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace apps/api --workspace packages/shared
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npx prisma generate --schema apps/api/prisma/schema.prisma
RUN npm run build --workspace apps/api

FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
# openssl: Prisma's query engine links against libssl. curl: HEALTHCHECK.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --workspace apps/api --workspace packages/shared \
  && npm cache clean --force
# The generated Prisma client (with the linux engine built in the same base
# image) — @prisma/client itself came from npm ci above.
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/apps/api/dist apps/api/dist
EXPOSE 3001
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:3001/api/v1/healthz || exit 1
CMD ["node", "apps/api/dist/server.js"]
