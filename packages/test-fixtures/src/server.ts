// -*- coding: utf-8 -*-
/**
 * server.ts
 * Owned loopback fixture service
 * =====================
 * Serve controlled native interaction surfaces with a read-only browser event recorder.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arch, platform, release } from 'node:os';

import { installRecorder } from './recorder.js';
import { FIXTURE_NAMES } from './trace.js';
import type { EventTraceEnvironment, FixtureName, TraceEngine } from './trace.js';

export const FIXTURE_VERSION = '1.0.0';

/** FixtureServer offers one owned loopback listener and explicit cleanup. */
export interface FixtureServer {
  origin: string;
  url(fixture: FixtureName): string;
  close(): Promise<void>;
}

/** FixtureServerOptions declare evidence supplied by the actual desktop test runner. */
export interface FixtureServerOptions {
  engine?: TraceEngine;
  environment?: Partial<EventTraceEnvironment>;
  maxSamples?: number;
}

// Each fixture contains controlled local interaction surfaces and observable outcomes.
const SURFACES: Record<FixtureName, string> = {
  'click-button': '<button id="activate">Activate</button>',
  'double-click': '<button id="double">Double activate</button>',
  'checkbox-radio':
    '<label><input id="checkbox" type="checkbox">Enable</label><label><input id="radio-one" type="radio" name="choice">First</label><label><input id="radio-two" type="radio" name="choice">Second</label>',
  'text-input-en': '<label>Query<input id="query" autocomplete="off"></label>',
  'text-input-cjk-ime':
    '<label>Composition<input id="composition" autocomplete="off"></label><p>Use the configured system input method to enter controlled fixture text.</p>',
  textarea: '<label>Notes<textarea id="notes"></textarea></label>',
  'select-native':
    '<label>Choice<select id="select"><option>First</option><option>Second</option><option>Third</option></select></label>',
  'date-time':
    '<label>Date<input id="date" type="date"></label><label>Time<input id="time" type="time"></label>',
  'file-dialog': '<label>Controlled file<input id="file" type="file"></label>',
  'drag-drop-html':
    '<div id="drag" draggable="true" tabindex="0">Drag fixture item</div><div id="drop" tabindex="0">Drop fixture item here</div>',
  'scroll-nested':
    '<div id="scroller" tabindex="0" style="width:320px;height:240px;overflow:scroll"><div style="width:720px;height:1200px">Controlled scrolling surface</div></div>',
  iframe: '<iframe id="frame" title="Owned frame" src="/frame"></iframe>',
  'shadow-dom': '<div id="shadow-host"></div>',
  'popup-user-activation': '<button id="popup">Open owned popup</button>',
  'tab-visibility':
    '<button id="activate">Activate</button><p>Switch to an independently owned browser tab and return.</p>',
  'back-forward-bfcache':
    '<a id="forward" href="/navigation-target">Open owned navigation target</a>',
  'clipboard-permission': '<button id="clipboard">Write controlled clipboard text</button>',
  download:
    '<a id="download" href="/download-file" download="abr-controlled.txt">Download controlled fixture</a>',
  'upload-confirm':
    '<label>Controlled file<input id="file" type="file"></label><button id="confirm-upload">Confirm owned upload</button><p>Confirmation records state locally.</p>',
  'focus-navigation':
    '<label>First<input id="first"></label><label>Second<input id="second"></label><button id="activate">Activate</button>',
  'touch-when-supported': '<button id="activate" style="touch-action:none">Touch activate</button>',
  'delayed-geometry':
    '<button id="move-target">Move target after delay</button><button id="moving-target">Moving target</button>',
  'privacy-sensitive':
    '<label>Public query<input id="query"></label><label>Password<input id="password" type="password" value="fixture-password"></label><label>Card<input id="card" autocomplete="cc-number" data-sensitive value="4111111111111111"></label><label>Protected note<textarea id="private-note" data-sensitive>fixture-private-note</textarea></label>',
};

/**
 * Escape embedded JSON for an inline owned document script.
 * Args:
 *   value (unknown): Trusted configuration values supplied to the recorder.
 * Returns:
 *   string: JSON that cannot terminate its containing script element.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/**
 * Render a controlled interaction surface with its self-contained recorder.
 * Args:
 *   fixture (FixtureName): Selected interaction surface.
 *   environment (EventTraceEnvironment): Fixed environment evidence.
 *   maxSamples (number): Maximum retained native event observations.
 * Returns:
 *   string: Owned HTML fixture with no remote dependencies.
 */
function render(
  fixture: FixtureName,
  environment: EventTraceEnvironment,
  maxSamples: number,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ABR ${fixture}</title>
<style>body{font:16px Arial;padding:24px}button,input,select,textarea{margin:12px;padding:10px}label{display:block}#counter{display:block}#drag,#drop{border:1px solid;padding:24px;margin:16px;width:240px}iframe{width:480px;height:240px}</style></head>
<body><h1>ABR ${fixture}</h1>${SURFACES[fixture]}<output id="counter">0</output>
<button id="recorder-export" data-recorder>Export candidate recording</button>
<script>(${installRecorder.toString()})(${scriptJson({ fixture, environment, maxSamples })});</script></body></html>`;
}

/**
 * Start an owned HTTP fixture listener bound exclusively to loopback.
 * Args:
 *   options (FixtureServerOptions): Test provenance and explicit environment overrides.
 * Returns:
 *   Promise<FixtureServer>: Listener origin, fixture URLs, and cleanup function.
 */
export async function startEventFixture(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const maxSamples = options.maxSamples ?? 10000;
  // Validate recording quotas before opening a local listener.
  if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 20000)
    throw new Error('Invalid fixture sample quota.');
  const provenance = options.engine ?? options.environment?.engine ?? 'manual';
  // Reject undeclared service options before any listener or recorder is created.
  for (const field of Object.keys(options)) {
    if (!['engine', 'environment', 'maxSamples'].includes(field))
      throw new Error('Unknown fixture service option.');
  }
  // Accept only declared input paths and known non-secret fixture metadata fields.
  if (!['manual', 'compatible', 'gui', 'native'].includes(provenance))
    throw new Error('Invalid fixture engine provenance.');
  const metadataFields = new Set([
    'os',
    'browserCommit',
    'engine',
    'osVersion',
    'arch',
    'windowSystem',
    'keyboardLayout',
    'ime',
    'monitorDpi',
    'abrVersion',
    'playwrightVersion',
    'profileId',
    'fixtureVersion',
    'pageUrl',
    'devicePixelRatio',
    'initialState',
  ]);
  // Closed configuration prevents accidental credential fields from entering trace metadata.
  for (const field of Object.keys(options.environment ?? {})) {
    // Unknown metadata is excluded rather than serialized into diagnostic artifacts.
    if (!metadataFields.has(field)) throw new Error('Unknown fixture environment field.');
  }
  const initialFields = new Set([
    'cookieStorageHash',
    'viewportWidth',
    'viewportHeight',
    'permissions',
    'focused',
    'tabCount',
  ]);
  // Initial-state evidence has a closed field set to exclude raw cookies and storage.
  for (const field of Object.keys(options.environment?.initialState ?? {})) {
    if (!initialFields.has(field)) throw new Error('Unknown fixture initial-state field.');
  }
  let origin = '';
  const environment: EventTraceEnvironment = {
    os: platform(),
    browserCommit: 'unknown',
    osVersion: release(),
    arch: arch(),
    windowSystem: 'unknown',
    keyboardLayout: 'unknown',
    ime: 'unknown',
    monitorDpi: 0,
    abrVersion: '0.1.0',
    playwrightVersion: 'not-applicable',
    profileId: 'unknown',
    fixtureVersion: FIXTURE_VERSION,
    pageUrl: '',
    initialState: {
      cookieStorageHash: 'unknown',
      viewportWidth: 0,
      viewportHeight: 0,
      permissions: 'unknown',
      focused: false,
      tabCount: 0,
    },
    ...options.environment,
    engine: provenance,
  };

  /**
   * Serve only named owned documents and bounded deterministic downloads.
   * Args:
   *   request (IncomingMessage): Incoming loopback browser request.
   *   response (ServerResponse): HTTP response for the controlled fixture.
   * Returns:
   *   void: Completion of the owned response.
   */
  function respond(request: IncomingMessage, response: ServerResponse): void {
    // Reject mutation methods and cross-origin request metadata.
    if (request.method !== 'GET' || (request.headers.origin && request.headers.origin !== origin)) {
      response.writeHead(405);
      response.end();
      return;
    }
    const pathname = new URL(request.url ?? '/', origin).pathname;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'",
    );
    // Provide a fixed download without reading any local filesystem path.
    if (pathname === '/download-file') {
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="abr-controlled.txt"',
      });
      response.end('ABR controlled fixture\n');
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Auxiliary navigation surfaces remain on the same owned loopback origin.
    if (['/popup', '/navigation-target'].includes(pathname)) {
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Owned ABR auxiliary page</title><h1>Owned ABR auxiliary page</h1>',
      );
      return;
    }
    // The iframe surface contains its own semantic controls with events observed by the parent.
    if (pathname === '/frame') {
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Owned ABR frame</title><button id="frame-activate">Frame activate</button><label>Frame query<input id="frame-query"></label>',
      );
      return;
    }
    const selected = pathname.slice(1);
    // The index lists controlled fixture routes without adding arbitrary URL routing.
    if (!selected) {
      response.end(
        '<!doctype html><meta charset="utf-8"><title>ABR owned fixtures</title><h1>ABR owned fixtures</h1><ul>' +
          FIXTURE_NAMES.map((name) => `<li><a href="/${name}">${name}</a></li>`).join('') +
          '</ul>',
      );
      return;
    }
    // Unknown routes have no filesystem or network fallback.
    if (!FIXTURE_NAMES.includes(selected as FixtureName)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.end(
      render(selected as FixtureName, { ...environment, pageUrl: origin + pathname }, maxSamples),
    );
  }
  const server = createServer(respond);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  // The explicitly requested ephemeral TCP listener must provide an actual port.
  if (!address || typeof address === 'string')
    throw new Error('Fixture listener has no local address.');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    /**
     * Construct a controlled fixture URL.
     * Args:
     *   fixture (FixtureName): Registered owned surface name.
     * Returns:
     *   string: Loopback fixture URL.
     */
    url(fixture: FixtureName): string {
      return `${origin}/${fixture}`;
    },
    /**
     * Close the owned listener and its active local HTTP connections.
     * Args:
     *   None.
     * Returns:
     *   Promise<void>: Completion of local fixture cleanup.
     */
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
