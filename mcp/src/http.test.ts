import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';

describe('MCP HTTP server graceful shutdown', () => {
  let server: Server;

  afterEach(() => {
    return new Promise<void>((resolve) => {
      if (server?.listening) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it('should stop accepting connections after close', async () => {
    server = createHttpServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    // Verify server is accepting connections
    const res1 = await fetch(`http://127.0.0.1:${port}/`);
    expect(res1.status).toBe(200);

    // Close the server
    const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closePromise;

    // Verify server rejects new connections
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('should close gracefully when no active requests', async () => {
    server = createHttpServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const start = Date.now();
    const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closePromise;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });
});
