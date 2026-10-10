/** ABR contract draft. TASK-002 owns implementation and runtime validation. */
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
  screenshot(sessionId: string): Promise<{ mimeType: 'image/png'; blobId: string }>;
  execute(input: ActionRequest): Promise<ActionResult>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}
