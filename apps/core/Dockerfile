FROM node:24.21.0-bookworm-slim

WORKDIR /app
ENV COREPACK_HOME=/tmp/kplus-corepack

RUN corepack enable && corepack prepare pnpm@10.21.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/core/package.json apps/core/tsconfig.json ./apps/core/
RUN pnpm install --frozen-lockfile --filter @kplus/core

COPY apps/core ./apps/core
RUN pnpm --filter @kplus/core exec tsc

EXPOSE 3000
CMD ["node", "apps/core/dist/src/main.js"]
