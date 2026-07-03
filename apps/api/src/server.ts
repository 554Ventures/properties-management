import { buildApp } from './app';

const port = Number(process.env.PORT ?? 3001);

const app = await buildApp({ logger: true });

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
