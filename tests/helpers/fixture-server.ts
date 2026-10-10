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
/**
 * Report event semantics from the public fixture input for native-path diagnostics.
 * Args:
 *   event (Event): Actual browser input event on the public Query control.
 * Returns:
 *   Promise<void>: Completion of the owned loopback diagnostic submission.
 */
async function reportInput(event) {
 const record = {type:event.type,code:event.code === 'Space' ? 'Space' : 'other',space:event.data === ' ',composing:Boolean(event.isComposing),trusted:event.isTrusted,inputType:event.inputType || ''};
 // Retry only diagnostic transport without repeating browser input.
 for(let attempt=0;attempt<3;attempt++) { try { const response=await fetch('/input-evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)}); if(response.ok) return; } catch {} }
}
for(const type of ['keydown','keyup','beforeinput','input','compositionstart','compositionend']) document.getElementById('query').addEventListener(type,reportInput);
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
  const evidence: Record<string, unknown>[] = [];
  // Collect bounded diagnostics solely from the explicitly owned public fixture input.
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/input-evidence') {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (body.length > 4096) request.destroy();
      });
      request.on('end', () => {
        try {
          const record = JSON.parse(body) as Record<string, unknown>;
          if (
            evidence.length < 512 &&
            Object.keys(record).every((key) =>
              ['type', 'code', 'space', 'composing', 'trusted', 'inputType'].includes(key),
            )
          )
            evidence.push(record);
          response.writeHead(204);
          response.end();
        } catch {
          response.writeHead(400);
          response.end();
        }
      });
      return;
    }
    respond(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener has no port.');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    /**
     * Read copied public-input event diagnostics.
     * Args:
     *   None.
     * Returns:
     *   object[]: Bounded diagnostic samples containing no submitted text.
     */
    inputEvidence() {
      return structuredClone(evidence);
    },
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
