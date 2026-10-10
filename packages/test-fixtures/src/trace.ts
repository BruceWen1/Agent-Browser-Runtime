// -*- coding: utf-8 -*-
/**
 * trace.ts
 * Event parity trace definitions
 * =====================
 * Describe fixture metadata, privacy filtered samples, and comparison evidence.
 */

// Fixture names correspond to independent interaction surfaces on the owned page.
export const FIXTURE_NAMES = [
  'click-button',
  'double-click',
  'checkbox-radio',
  'text-input-en',
  'text-input-cjk-ime',
  'textarea',
  'select-native',
  'date-time',
  'file-dialog',
  'drag-drop-html',
  'scroll-nested',
  'iframe',
  'shadow-dom',
  'popup-user-activation',
  'tab-visibility',
  'back-forward-bfcache',
  'clipboard-permission',
  'download',
  'upload-confirm',
  'focus-navigation',
  'touch-when-supported',
  'delayed-geometry',
  'privacy-sensitive',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];
export type TraceEngine = 'manual' | 'compatible' | 'gui' | 'native';

/** EventTraceEnvironment identifies the platform and fixed comparison variables. */
export interface EventTraceEnvironment {
  os: string;
  browserCommit: string;
  engine: TraceEngine;
  osVersion: string;
  arch: string;
  windowSystem: string;
  keyboardLayout: string;
  ime: string;
  monitorDpi: number;
  abrVersion: string;
  playwrightVersion: string;
  profileId: string;
  fixtureVersion: string;
  pageUrl: string;
  devicePixelRatio?: number;
  initialState: {
    cookieStorageHash: string;
    viewportWidth: number;
    viewportHeight: number;
    permissions: string;
    focused: boolean;
    tabCount: number;
  };
}

/** EventSample stores observable semantics while filtering private text. */
export interface EventSample {
  type: string;
  trusted: boolean;
  timestampMs: number;
  phase: 'capture' | 'bubble' | 'observer';
  target: string;
  focus: string;
  activation: boolean;
  hasBeenActive: boolean;
  visibility: string;
  historyLength: number;
  pagePath?: string;
  referrerOrigin?: string;
  key?: string;
  code?: string;
  repeat?: boolean;
  modifiers?: string[];
  inputType?: string;
  composing?: boolean;
  textLength?: number;
  button?: number;
  buttons?: number;
  pointerType?: string;
  clientX?: number;
  clientY?: number;
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  selection?: { anchor: string; focus: string; start: number; end: number };
  detail?: string;
}

/** EventTrace provides a bounded, versioned event recording. */
export interface EventTrace {
  schemaVersion: 1;
  fixture: string;
  environment: EventTraceEnvironment;
  samples: EventSample[];
  outcome: {
    controls: Record<string, { valueHash?: string; checked?: boolean; selectedIndex?: number }>;
    counter: number;
    focus: string;
    selection: EventSample['selection'] | null;
    visibility: string;
    scroll: { x: number; y: number };
    popup: 'not-requested' | 'opened' | 'blocked';
    clipboard: 'not-requested' | 'granted' | 'denied';
    uploadConfirmed: boolean;
    dropped: boolean;
    truncated: boolean;
  };
}

/** FixtureControl supplies read-only page trace exports to an owned test harness. */
export interface FixtureControl {
  exportTrace(): Promise<EventTrace>;
}

/** TraceDifference records one deterministic or tolerated discrepancy. */
export interface TraceDifference {
  path: string;
  reason: string;
  severity: 'unexpected' | 'accepted';
  baseline: unknown;
  actual: unknown;
}

export type ParityStatus =
  'identical' | 'accepted-diff' | 'unexpected-diff' | 'unsupported' | 'invalid-fixture';

/** ParityReport identifies differences, provenance, and replay instructions. */
export interface ParityReport {
  schemaVersion: 1;
  fixture: string;
  status: ParityStatus;
  manualBaselineApproved: boolean;
  differences: TraceDifference[];
  baselineEnvironment: EventTraceEnvironment;
  actualEnvironment: EventTraceEnvironment;
  replaySteps: string[];
  normalization: {
    timestampToleranceMs: number;
    coordinateToleranceCssPx: number;
    collapsePointerMotion: boolean;
  };
}
