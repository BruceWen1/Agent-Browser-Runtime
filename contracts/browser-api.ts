// -*- coding: utf-8 -*-
/**
 * browser-api.ts
 * Browser runtime public contracts
 * =====================
 * Define session, observation, action, and engine data shared by adapters.
 */
export type Engine = 'compatible' | 'gui' | 'native';
export type SessionStatus =
  'creating' | 'ready' | 'busy' | 'paused' | 'closing' | 'closed' | 'failed';
export type ExecutionPath =
  'playwright-cdp' | 'os-input' | 'chromium-observer' | 'playwright-script' | 'not-executed';
export type CoordinateSpace = 'viewport-css' | 'window-dip' | 'screen-physical';
export type Capability =
  | 'observe.ax'
  | 'observe.screenshot'
  | 'window.focus'
  | 'input.pointer'
  | 'input.keyboard'
  | 'input.ime'
  | 'browser.navigate'
  | 'browser.tabs'
  | 'browser.fileDialog'
  | 'script.evaluate'
  | 'network.intercept';
export interface CreateSessionRequest {
  engine: Engine;
  browser: 'bundled-chromium' | 'installed-chrome' | 'custom-chromium';
  profile: { mode: 'ephemeral' | 'persistent'; name?: string };
  headless?: boolean;
  locale?: string;
  allowedOrigins?: string[];
}
export interface BrowserSession {
  id: string;
  engine: Engine;
  status: SessionStatus;
  browserVersion: string;
  browserCommit?: string;
  playwrightVersion?: string;
  platform: string;
  capabilities: Capability[];
  createdAt: string;
  profileId: string;
}
export interface AxNode {
  nodeId: string;
  role: string;
  name?: string;
  value?: string;
  states: string[];
  bounds?: { x: number; y: number; width: number; height: number; space: CoordinateSpace };
  children?: AxNode[];
}
export interface BrowserSnapshot {
  sessionId: string;
  snapshotId: string;
  timestamp: string;
  windowId: string;
  tabId?: string;
  root: AxNode;
  scale: { dpr: number; zoom: number };
  source: 'os-accessibility' | 'chromium-accessibility' | 'playwright-accessibility';
  url?: string;
  tabs?: BrowserTab[];
  geometry?: {
    windowOrigin: { x: number; y: number };
    viewportOrigin: { x: number; y: number };
    monitorScale: number;
  };
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}
export type Target =
  | { kind: 'ax-node'; snapshotId: string; nodeId: string }
  | { kind: 'coordinate'; x: number; y: number; space: CoordinateSpace; windowId: string };
export interface ActionRequest {
  requestId: string;
  sessionId: string;
  action: string;
  target?: Target;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  expectedSnapshotId?: string;
}
export type BrowserErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CLOSED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PERMISSION_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'POLICY_DENIED'
  | 'TARGET_STALE'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_OCCLUDED'
  | 'FOCUS_LOST'
  | 'DESKTOP_BUSY'
  | 'INPUT_BACKEND_UNAVAILABLE'
  | 'BROWSER_DISCONNECTED'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';
export interface ActionResult {
  requestId: string;
  actionId: string;
  sessionId: string;
  status: 'succeeded' | 'failed' | 'approval-required' | 'cancelled';
  executionPath: ExecutionPath;
  startedAt: string;
  finishedAt: string;
  snapshotIdAfter?: string;
  approvalId?: string;
  actualStrategy?:
    'playwright-keyboard' | 'playwright-insert-text' | 'os-keyboard' | 'os-unicode' | 'os-ime';
  artifacts?: string[];
  error?: { code: BrowserErrorCode; message: string; retryable: boolean; nextAction?: string };
}
export interface CapabilityReport {
  supported: Capability[];
  unsupported: Partial<Record<Capability, string>>;
}
export interface BrowserEngine {
  readonly kind: Engine;
  create(input: CreateSessionRequest): Promise<BrowserSession>;
  capabilities(sessionId: string): Promise<CapabilityReport>;
  observe(sessionId: string): Promise<BrowserSnapshot>;
  currentUrl(sessionId: string): Promise<string>;
  screenshot(sessionId: string): Promise<{ mimeType: 'image/png'; blobId: string }>;
  execute(input: ActionRequest): Promise<ActionResult>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  cancel?(sessionId: string): Promise<void>;
}
