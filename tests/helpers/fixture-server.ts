// -*- coding: utf-8 -*-
/**
 * fixture-server.ts
 * Owned browser integration fixture
 * =====================
 * Serve isolated deterministic controls on an ephemeral loopback HTTP port.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Controls provide accessible names and observable outcomes for browser integration tests.
const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>ABR fixture</title>
<style>body{font-family:Arial;padding:24px}button,input{margin:12px;padding:10px}#counter{display:block}</style>
<button id="activate">Activate</button><label>Query<input id="query"></label>
<label>Password<input id="password" type="password" value="fixture-secret"></label>
<output id="counter">0</output><script>
/**
 * Update the controlled fixture activation counter.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of the visible counter update.
 */
function activate() { const counter = document.getElementById('counter'); counter.textContent = String(Number(counter.textContent) + 1); }
document.getElementById('activate').addEventListener('click', activate);
</script></html>`;

/**
 * Answer a local browser fixture request.
 * Args:
 *   request (IncomingMessage): Browser request received on the loopback listener.
 *   response (ServerResponse): Response for the controlled page.
 * Returns:
 *   void: Completion of the local fixture response.
 */
function respond(request: IncomingMessage, response: ServerResponse): void {
  // Serve only the controlled document and avoid filesystem path translation.
  if (request.method !== 'GET') {
    response.writeHead(405);
    response.end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(PAGE);
}

/**
 * Start an owned fixture on an ephemeral loopback port.
 * Args:
 *   None.
 * Returns:
 *   Promise<object>: Local origin and asynchronous cleanup function.
 */
export async function startFixture() {
  const server = createServer(respond);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener has no port.');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    /**
     * Close the controlled loopback listener.
     * Args:
     *   None.
     * Returns:
     *   Promise<void>: Completion of listener shutdown.
     */
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
