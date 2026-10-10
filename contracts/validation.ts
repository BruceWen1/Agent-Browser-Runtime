// -*- coding: utf-8 -*-
/**
 * validation.ts
 * Runtime schema validation
 * =====================
 * Validate shared JSON contracts and derive MCP schemas from canonical inputs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import * as z from 'zod/v4';

import type {
  ActionRequest,
  BrowserSession,
  Capability,
  CreateSessionRequest,
} from './browser-api.js';
import { BrowserError } from './errors.js';

export type JsonSchema = Exclude<Parameters<typeof z.fromJSONSchema>[0], boolean>;
export interface ToolDefinition {
  name: string;
  inputSchema: JsonSchema;
  requiredCapability: Capability | null;
  humanApproval: boolean;
  risk: string;
}

export const CAPABILITIES: readonly Capability[] = [
  'observe.ax',
  'observe.screenshot',
  'window.focus',
  'input.pointer',
  'input.keyboard',
  'input.ime',
  'browser.navigate',
  'browser.tabs',
  'browser.fileDialog',
  'script.evaluate',
  'network.intercept',
];

// Resolve schemas both from original source modules and compiled package modules.
const schemaRoot = existsSync(new URL('./mcp-tools.json', import.meta.url)) ? './' : '../';
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
// Enable URI and timestamp validation across input and session contracts.
const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();

/**
 * Load a trusted JSON document included with the contract package.
 *
 * Args:
 *   filename (string): Constant package document filename.
 * Returns:
 *   unknown: Parsed JSON document.
 */
function loadDocument(filename: string): unknown {
  return JSON.parse(
    readFileSync(new URL(schemaRoot + filename, import.meta.url), 'utf8'),
  ) as unknown;
}

export const MCP_TOOLS = (loadDocument('mcp-tools.json') as { tools: ToolDefinition[] }).tools;

// Compile all advertised input contracts from the shared package documents.
for (const tool of MCP_TOOLS) validators.set(tool.name, ajv.compile(tool.inputSchema));
// Compile the session, action, trace, and IPC envelope validators once per process.
for (const name of ['session', 'action', 'browser-event', 'ipc-request', 'ipc-response']) {
  validators.set(name, ajv.compile(loadDocument(`${name}.schema.json`) as JsonSchema));
}

/**
 * Validate a JSON value against a registered contract.
 *
 * Args:
 *   name (string): Registered tool or shared schema name.
 *   value (unknown): Value received at an application or IPC boundary.
 * Returns:
 *   void: Successful validation.
 */
export function validate(name: string, value: unknown): void {
  const validator = validators.get(name);
  // Reject unknown schemas and invalid values with field locations only.
  if (!validator || !validator(value)) {
    const locations =
      validator?.errors?.map((error) => error.instancePath || '/').join(', ') ?? '/';
    throw new BrowserError('INVALID_ARGUMENT', `Invalid ${name} contract at ${locations}.`);
  }
}

/**
 * Derive an SDK-compatible Zod schema from a canonical MCP input contract.
 *
 * Args:
 *   tool (ToolDefinition): Tool definition loaded from the shared manifest.
 * Returns:
 *   z.ZodObject: Object schema preserving canonical JSON Schema metadata.
 */
export function toolInputSchema(tool: ToolDefinition): z.ZodObject {
  const schema = z.fromJSONSchema(tool.inputSchema);
  // MCP tool inputs require object schemas at the protocol boundary.
  if (!(schema instanceof z.ZodObject)) throw new Error('Tool input schema must be an object.');
  return schema.meta(tool.inputSchema);
}

/**
 * Validate session creation and engine-specific constraints.
 *
 * Args:
 *   value (unknown): Proposed browser session configuration.
 * Returns:
 *   CreateSessionRequest: Validated session request.
 */
export function parseSession(value: unknown): CreateSessionRequest {
  validate('browser_session_create', value);
  const input = value as CreateSessionRequest;
  // A persistent profile requires a stable explicit profile name.
  if (input.profile.mode === 'persistent' && !input.profile.name) {
    throw new BrowserError('INVALID_ARGUMENT', 'Persistent profiles require a profile name.');
  }
  // GUI engines require a real visible browser window.
  if (input.engine !== 'compatible' && input.headless) {
    throw new BrowserError('INVALID_ARGUMENT', 'GUI and Native sessions require a visible window.');
  }
  return input;
}

// Each internal action maps to exactly one strict public tool input schema.
export const ACTION_TO_TOOL: Readonly<Record<string, string>> = {
  click: 'browser_click',
  'double-click': 'browser_double_click',
  'pointer-move': 'browser_pointer_move',
  'key-press': 'browser_key_press',
  'type-text': 'browser_type_text',
  scroll: 'browser_scroll',
  drag: 'browser_drag',
  navigate: 'browser_navigate',
  'go-back': 'browser_go_back',
  'switch-tab': 'browser_switch_tab',
  'choose-file': 'browser_choose_file',
};

/**
 * Validate an action envelope and its action-specific arguments.
 *
 * Args:
 *   value (unknown): Proposed action submitted to the runtime.
 * Returns:
 *   ActionRequest: Validated and bounded action request.
 */
export function parseAction(value: unknown): ActionRequest {
  validate('action', value);
  const input = value as ActionRequest;
  const toolName = ACTION_TO_TOOL[input.action];
  // Reject operations without a registered and strict capability contract.
  if (!toolName) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'The action is not registered.');
  // Prevent argument fields from replacing trusted envelope identifiers.
  for (const key of ['sessionId', 'requestId', 'target']) {
    // Reserved identifiers are accepted only at the envelope level.
    if (input.args && Object.hasOwn(input.args, key)) {
      throw new BrowserError('INVALID_ARGUMENT', 'Action arguments contain a reserved field.');
    }
  }
  validate(toolName, {
    sessionId: input.sessionId,
    requestId: input.requestId,
    ...(input.target ? { target: input.target } : {}),
    ...input.args,
  });
  return input;
}

/**
 * Validate an engine-produced session at the application boundary.
 *
 * Args:
 *   value (unknown): Session returned by a browser adapter.
 * Returns:
 *   BrowserSession: Validated session metadata.
 */
export function parseBrowserSession(value: unknown): BrowserSession {
  validate('session', value);
  return value as BrowserSession;
}
