import { buildServer } from './server.js';

const app = buildServer({ logger: true });
const port = Number(process.env.COURIER_PORT ?? 3001);

try {
  await app.listen({ host: '0.0.0.0', port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
