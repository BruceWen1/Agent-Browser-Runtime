// -*- coding: utf-8 -*-
/**
 * recorder.ts
 * Owned DOM event recorder
 * =====================
 * Capture native event semantics and export bounded privacy filtered fixture traces.
 */
import type { EventSample, EventTrace, EventTraceEnvironment, FixtureControl } from './trace.js';

/** RecorderConfiguration identifies one controlled fixture recording. */
export interface RecorderConfiguration {
  fixture: string;
  environment: EventTraceEnvironment;
  maxSamples: number;
}

/**
 * Install event observation inside an explicitly owned fixture document.
 * Args:
 *   configuration (RecorderConfiguration): Fixed trace metadata and sample bound.
 * Returns:
 *   void: Installation of read-only exportTrace and native event listeners.
 */
export function installRecorder(configuration: RecorderConfiguration): void {
  const samples: EventSample[] = [];
  const started = performance.now();
  let truncated = false;
  let popup: EventTrace['outcome']['popup'] = 'not-requested';
  let clipboard: EventTrace['outcome']['clipboard'] = 'not-requested';
  let dropped = false;
  let uploadConfirmed = false;
  // Capture initial storage through a digest and omit raw storage from every exported artifact.
  const initialStorage = hash(
    JSON.stringify({ cookie: document.cookie, storage: { ...localStorage } }),
  );
  configuration.environment.initialState.viewportWidth = innerWidth;
  configuration.environment.initialState.viewportHeight = innerHeight;
  configuration.environment.initialState.focused = document.hasFocus();
  configuration.environment.devicePixelRatio = devicePixelRatio;

  /**
   * Identify DOM elements across same-origin iframe JavaScript realms.
   * Args:
   *   target (EventTarget | null): Observed event target.
   * Returns:
   *   boolean: Whether the target is a DOM element.
   */
  function isElement(target: EventTarget | null): target is Element {
    return target !== null && 'nodeType' in target && (target as Node).nodeType === 1;
  }

  /**
   * Identify an event target using a stable owned fixture identifier.
   * Args:
   *   target (EventTarget | null): Event target or selected DOM node.
   * Returns:
   *   string: Controlled identifier or semantic node tag.
   */
  function identify(target: EventTarget | null): string {
    // Represent text nodes through their owning element without including text.
    if (target && 'nodeType' in target && !isElement(target))
      return identify((target as Node).parentElement);
    // Represent document and window lifecycle events explicitly.
    if (target === document) return 'document';
    if (target === window) return 'window';
    return isElement(target) ? target.id || target.tagName.toLowerCase() : '';
  }

  /**
   * Recognize protected fields across light DOM and composed event targets.
   * Args:
   *   target (EventTarget | null): Element receiving an observed event.
   * Returns:
   *   boolean: Whether text and keyboard details require full masking.
   */
  function sensitive(target: EventTarget | null): boolean {
    return (
      isElement(target) &&
      Boolean(target.closest('[data-sensitive],input[type=password],[autocomplete^="cc-"]'))
    );
  }

  /**
   * Read the active control through owned iframe and open shadow boundaries.
   * Args:
   *   None.
   * Returns:
   *   Element | null: Actual public browser focus target.
   */
  function focused(): Element | null {
    let active = document.activeElement;
    // Bound focus descent across the fixture's same-origin nested documents.
    for (let depth = 0; depth < 8 && active; depth += 1) {
      const realm = (active.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
      const nested: Element | null =
        active.shadowRoot?.activeElement ??
        (active instanceof realm.HTMLIFrameElement
          ? (active.contentDocument?.activeElement ?? null)
          : null);
      // The current element is the final native focus target when it has no nested focus.
      if (!nested) break;
      active = nested;
    }
    return active;
  }

  /**
   * Capture selection offsets without exporting selected text.
   * Args:
   *   None.
   * Returns:
   *   EventSample['selection'] | null: Public control or document selection positions.
   */
  function selection(): EventSample['selection'] | null {
    const active = focused();
    // Protected inputs expose neither offsets nor selection content.
    if (sensitive(active)) return null;
    // Input and textarea selections expose offsets through native control properties.
    const realm = (active?.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
    if (active instanceof realm.HTMLInputElement || active instanceof realm.HTMLTextAreaElement) {
      return {
        anchor: identify(active),
        focus: identify(active),
        start: active.selectionStart ?? 0,
        end: active.selectionEnd ?? 0,
      };
    }
    const selected = realm.getSelection();
    // An empty document selection has no meaningful offset evidence.
    if (!selected?.anchorNode || !selected.focusNode) return null;
    return {
      anchor: identify(selected.anchorNode),
      focus: identify(selected.focusNode),
      start: selected.anchorOffset,
      end: selected.focusOffset,
    };
  }

  /**
   * Append a sample while maintaining the declared recording quota.
   * Args:
   *   sample (EventSample): Privacy filtered observation.
   * Returns:
   *   void: Bounded append or an explicit truncation marker.
   */
  function append(sample: EventSample): void {
    // Stop storing samples at the quota and expose invalid recording state.
    if (samples.length >= configuration.maxSamples) {
      truncated = true;
      return;
    }
    samples.push(sample);
  }

  /**
   * Capture one native event without changing its trusted or activation state.
   * Args:
   *   event (Event): Browser-dispatched event.
   *   phase ('capture' | 'bubble'): Listener phase being recorded.
   * Returns:
   *   void: Completion of privacy filtered event sampling.
   */
  function capture(event: Event, phase: 'capture' | 'bubble'): void {
    const target = event.composedPath()[0] ?? event.target;
    // Export controls are excluded so retrieving a manual recording adds no fixture action.
    if (isElement(target) && target.closest('[data-recorder]')) return;
    const realm = (
      isElement(target) ? (target.ownerDocument.defaultView ?? window) : window
    ) as Window & typeof globalThis;
    const protectedTarget = sensitive(target);
    const sample: EventSample = {
      type: event.type,
      trusted: event.isTrusted,
      timestampMs: performance.now() - started,
      phase,
      target: identify(target),
      focus: identify(focused()),
      activation: navigator.userActivation.isActive,
      hasBeenActive: navigator.userActivation.hasBeenActive,
      visibility: document.visibilityState,
      historyLength: history.length,
      pagePath: location.pathname,
      referrerOrigin: document.referrer ? new URL(document.referrer).origin : '',
    };
    const positions = selection();
    // Store public selection offsets only when available.
    if (positions) sample.selection = positions;
    // Preserve pointer geometry and device semantics for controlled targets.
    if (event instanceof realm.MouseEvent) {
      Object.assign(sample, {
        button: event.button,
        buttons: event.buttons,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    }
    // Record physical key identifiers for public inputs and mask protected keys completely.
    if (event instanceof realm.KeyboardEvent) {
      sample.key = protectedTarget
        ? '<redacted>'
        : event.key.length === 1
          ? '<character>'
          : event.key;
      sample.code = protectedTarget ? '<redacted>' : event.code;
      sample.repeat = event.repeat;
      sample.composing = event.isComposing;
      sample.modifiers = ['Alt', 'Control', 'Meta', 'Shift'].filter((name) =>
        event.getModifierState(name),
      );
    }
    // Store input and composition structure while keeping text content private.
    if (event instanceof realm.InputEvent) {
      sample.inputType = event.inputType;
      sample.composing = event.isComposing;
      // Expose composition lengths only for public fixture fields.
      if (!protectedTarget) sample.textLength = event.data?.length ?? 0;
    }
    // Composition event lengths support sequence validation without exporting composed text.
    if (event instanceof realm.CompositionEvent && !protectedTarget)
      sample.textLength = event.data.length;
    // Pointer events retain their native device classification.
    if (event instanceof realm.PointerEvent) sample.pointerType = event.pointerType;
    // Preserve wheel units and signed deltas for nested scrolling comparisons.
    if (event instanceof realm.WheelEvent)
      Object.assign(sample, {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      });
    // Lifecycle details contain safe booleans rather than URL or storage values.
    if (event instanceof PageTransitionEvent)
      sample.detail = event.persisted ? 'persisted' : 'fresh';
    append(sample);
  }

  // Attach capture and bubble listeners to preserve actual propagation evidence.
  const names = [
    'pointerdown',
    'pointerup',
    'pointermove',
    'pointercancel',
    'gotpointercapture',
    'lostpointercapture',
    'mousedown',
    'mouseup',
    'click',
    'dblclick',
    'wheel',
    'scroll',
    'keydown',
    'keyup',
    'beforeinput',
    'input',
    'change',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'focus',
    'blur',
    'focusin',
    'focusout',
    'selectionchange',
    'dragstart',
    'dragenter',
    'dragover',
    'dragleave',
    'dragend',
    'drop',
    'visibilitychange',
    'touchstart',
    'touchmove',
    'touchend',
    'touchcancel',
  ];
  for (const name of names) {
    document.addEventListener(name, (event) => capture(event, 'capture'), {
      capture: true,
      passive: true,
    });
    document.addEventListener(name, (event) => capture(event, 'bubble'), { passive: true });
  }
  // Window lifecycle listeners observe navigation without cancelling unload or disabling BFCache.
  for (const name of ['pageshow', 'pagehide', 'popstate', 'hashchange']) {
    window.addEventListener(name, (event) => capture(event, 'capture'));
  }

  /**
   * Summarize owned DOM mutations without collecting text or private attributes.
   * Args:
   *   mutations (MutationRecord[]): Mutation observer records.
   * Returns:
   *   void: Completion of safe mutation sampling.
   */
  function mutationsChanged(mutations: MutationRecord[]): void {
    // Preserve mutation categories and target ordering with bounded safe summaries.
    for (const mutation of mutations) {
      const sample: EventSample = {
        type: 'mutation',
        trusted: false,
        timestampMs: performance.now() - started,
        phase: 'observer',
        target: identify(mutation.target),
        focus: identify(focused()),
        activation: navigator.userActivation.isActive,
        hasBeenActive: navigator.userActivation.hasBeenActive,
        visibility: document.visibilityState,
        historyLength: history.length,
        detail: mutation.type + (mutation.attributeName ? ':' + mutation.attributeName : ''),
      };
      append(sample);
    }
  }
  new MutationObserver(mutationsChanged).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['checked', 'disabled', 'hidden', 'style', 'aria-expanded'],
  });

  /**
   * Hash a public fixture value for deterministic final-state comparison.
   * Args:
   *   value (string): Public controlled input value.
   * Returns:
   *   Promise<string>: SHA-256 digest without raw input text.
   */
  async function hash(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Export a copied trace with current safe outcome and initial environment evidence.
   * Args:
   *   None.
   * Returns:
   *   Promise<EventTrace>: Bounded observation artifact with protected controls omitted.
   */
  async function exportTrace(): Promise<EventTrace> {
    const controls: EventTrace['outcome']['controls'] = {};
    // Capture final public control state while excluding passwords, card details, and filenames.
    const shadow = document.getElementById('shadow-host')?.shadowRoot;
    const frame = (document.getElementById('frame') as HTMLIFrameElement | null)?.contentDocument;
    const allControls = [
      ...document.querySelectorAll('input,textarea,select'),
      ...(shadow?.querySelectorAll('input,textarea,select') ?? []),
      ...(frame?.querySelectorAll('input,textarea,select') ?? []),
    ];
    // Capture every public control through its own same-origin JavaScript realm.
    for (const control of allControls) {
      const realm = (control.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
      // Exclude sensitive content and local filenames from outcome snapshots.
      if (
        sensitive(control) ||
        (control instanceof realm.HTMLInputElement && control.type === 'file')
      )
        continue;
      // Public input state includes its content digest and native checked state.
      if (control instanceof realm.HTMLInputElement)
        controls[control.id] = { valueHash: await hash(control.value), checked: control.checked };
      // Public textarea content contributes only its deterministic digest.
      if (control instanceof realm.HTMLTextAreaElement)
        controls[control.id] = { valueHash: await hash(control.value) };
      // Native selection state is represented by its selected option index.
      if (control instanceof realm.HTMLSelectElement)
        controls[control.id] = { selectedIndex: control.selectedIndex };
    }
    configuration.environment.initialState.cookieStorageHash = await initialStorage;
    return {
      schemaVersion: 1,
      fixture: configuration.fixture,
      environment: structuredClone(configuration.environment),
      samples: structuredClone(samples),
      outcome: {
        controls,
        counter: Number(document.getElementById('counter')?.textContent ?? 0),
        focus: identify(focused()),
        selection: selection(),
        visibility: document.visibilityState,
        scroll: {
          x: document.getElementById('scroller')?.scrollLeft ?? 0,
          y: document.getElementById('scroller')?.scrollTop ?? 0,
        },
        popup,
        clipboard,
        uploadConfirmed,
        dropped,
        truncated,
      },
    };
  }
  // Expose observation only; input and recorder reset commands remain absent.
  Object.defineProperty(window, 'abrFixture', {
    value: Object.freeze({ exportTrace } satisfies FixtureControl),
    writable: false,
    configurable: false,
  });

  /**
   * Update the fixture counter after an ordinary button activation.
   * Args:
   *   None.
   * Returns:
   *   void: Updated visible deterministic counter.
   */
  function activate(): void {
    const counter = document.getElementById('counter')!;
    counter.textContent = String(Number(counter.textContent) + 1);
  }
  document.getElementById('activate')?.addEventListener('click', activate);
  document.getElementById('double')?.addEventListener('dblclick', activate);

  /**
   * Observe same-origin iframe events through the frame document.
   * Args:
   *   None.
   * Returns:
   *   void: Installed owned frame event observation and counter behavior.
   */
  function frameLoaded(): void {
    const frame = (document.getElementById('frame') as HTMLIFrameElement | null)?.contentDocument;
    // A detached or unloaded frame has no observable controls.
    if (!frame) return;
    // Observe both propagation phases through the same-origin frame document.
    for (const name of names) {
      frame.addEventListener(name, (event) => capture(event, 'capture'), {
        capture: true,
        passive: true,
      });
      frame.addEventListener(name, (event) => capture(event, 'bubble'), { passive: true });
    }
    frame.getElementById('frame-activate')?.addEventListener('click', activate);
  }
  document.getElementById('frame')?.addEventListener('load', frameLoaded);
  const shadowHost = document.getElementById('shadow-host');
  // Build an ordinary open shadow tree for composed-path event and AX tests.
  if (shadowHost) {
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<button id="shadow-activate">Shadow activate</button><label>Shadow query<input id="shadow-query"></label>';
    shadow.getElementById('shadow-activate')?.addEventListener('click', activate);
  }

  /**
   * Exercise the real popup API using the browser's current activation state.
   * Args:
   *   None.
   * Returns:
   *   void: Recorded popup success or denial.
   */
  function openPopup(): void {
    const opened = window.open('/popup', 'abr-fixture-popup', 'width=360,height=240');
    popup = opened ? 'opened' : 'blocked';
  }
  document.getElementById('popup')?.addEventListener('click', openPopup);

  /**
   * Exercise clipboard permission with controlled fixture text.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Recorded browser permission outcome.
   */
  async function useClipboard(): Promise<void> {
    // Clipboard failures represent browser permission outcomes in the fixture artifact.
    try {
      await navigator.clipboard.writeText('ABR controlled fixture');
      clipboard = 'granted';
    } catch {
      clipboard = 'denied';
    }
  }
  document.getElementById('clipboard')?.addEventListener('click', useClipboard);

  /**
   * Permit the owned drop zone to receive native HTML drag events.
   * Args:
   *   event (DragEvent): Drag movement over the fixture drop zone.
   * Returns:
   *   void: Native drop eligibility.
   */
  function allowDrop(event: DragEvent): void {
    event.preventDefault();
  }
  /**
   * Record the fixture drop outcome without inspecting transferred content.
   * Args:
   *   event (DragEvent): Native drop event.
   * Returns:
   *   void: Updated controlled drop state.
   */
  function receiveDrop(event: DragEvent): void {
    event.preventDefault();
    dropped = true;
  }
  document.getElementById('drop')?.addEventListener('dragover', allowDrop);
  document.getElementById('drop')?.addEventListener('drop', receiveDrop);

  /**
   * Record explicit upload confirmation without transferring selected file bytes.
   * Args:
   *   None.
   * Returns:
   *   void: Confirmation outcome for the owned fixture.
   */
  function confirmUpload(): void {
    uploadConfirmed = true;
  }
  document.getElementById('confirm-upload')?.addEventListener('click', confirmUpload);

  /**
   * Move the geometry fixture after a native button action for stale-target tests.
   * Args:
   *   None.
   * Returns:
   *   void: Scheduled position change on the owned target.
   */
  function moveDelayedTarget(): void {
    setTimeout(() => {
      document.getElementById('moving-target')!.style.marginLeft = '160px';
    }, 250);
  }
  document.getElementById('move-target')?.addEventListener('click', moveDelayedTarget);

  /**
   * Save a manually retrieved recording as a candidate trace download.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Downloaded observation with unchanged approval status.
   */
  async function downloadTrace(): Promise<void> {
    const trace = await exportTrace();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'abr-fixture-trace.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.getElementById('recorder-export')?.addEventListener('click', downloadTrace);
}
