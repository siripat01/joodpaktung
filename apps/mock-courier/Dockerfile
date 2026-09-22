FROM node:24.21.0-bookworm-slim

WORKDIR /app
ENV COREPACK_HOME=/tmp/kplus-corepack

RUN corepack enable && corepack prepare pnpm@10.21.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/mock-courier/package.json apps/mock-courier/tsconfig.json ./apps/mock-courier/
RUN pnpm install --frozen-lockfile --filter @kplus/mock-courier

COPY apps/mock-courier ./apps/mock-courier
RUN pnpm --filter @kplus/mock-courier exec tsc

EXPOSE 3001
CMD ["node", "apps/mock-courier/dist/src/main.js"]
