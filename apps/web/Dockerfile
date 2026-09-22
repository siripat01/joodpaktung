FROM node:24.21.0-bookworm-slim

WORKDIR /app
ENV COREPACK_HOME=/tmp/kplus-corepack

RUN corepack enable && corepack prepare pnpm@10.21.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts ./apps/web/
RUN pnpm install --frozen-lockfile --filter @kplus/web

COPY apps/web ./apps/web

EXPOSE 5173
CMD ["pnpm", "--filter", "@kplus/web", "exec", "vite", "--host", "0.0.0.0", "--port", "5173"]
