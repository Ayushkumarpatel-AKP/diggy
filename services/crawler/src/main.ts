import { DEFAULT_PORT, startServer } from './server.js';

const rawPort = process.env.PORT;
const port = rawPort && /^\d+$/.test(rawPort) ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;

startServer(port)
  .then(() => {
    console.log(`@diggy/crawler listening on http://127.0.0.1:${port}`);
  })
  .catch((error: unknown) => {
    console.error('Failed to start @diggy/crawler:', error);
    process.exitCode = 1;
  });
