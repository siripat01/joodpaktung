# K+ โอนซื้อของ

Offline conditional-payment proof of concept.

## Development

This workspace uses Node.js 24.21.0 and pnpm 10.21.0 through Corepack.

```sh
corepack enable
corepack prepare pnpm@10.21.0 --activate
pnpm install
pnpm test
```

## Offline Compose

While connected, preload every image used by Compose and build the application images:

```sh
docker pull node:24.21.0-bookworm-slim
docker pull golang:1.27.1-bookworm
docker pull postgres:18.6-alpine
docker compose build
```

After the images are built, start the full stack without pulling or rebuilding:

```sh
docker compose up --no-build
```
