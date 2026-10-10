// -*- coding: utf-8 -*-
/**
 * registry.ts
 * Browser engine registration
 * =====================
 * Register explicitly selected engines without coupling the core to adapters.
 */
import { BrowserError } from '@abr/contracts';
import type { BrowserEngine, Engine } from '@abr/contracts';

/** EngineRegistry stores one adapter for each public execution engine. */
export class EngineRegistry {
  private readonly engines = new Map<Engine, BrowserEngine>();

  /**
   * Register an adapter with a unique engine identity.
   *
   * Args:
   *   engine (BrowserEngine): Adapter implementing the public browser interface.
   * Returns:
   *   void: Completion of adapter registration.
   */
  register(engine: BrowserEngine): void {
    // Prevent an adapter from replacing an existing engine implicitly.
    if (this.engines.has(engine.kind))
      throw new BrowserError('INVALID_ARGUMENT', 'Engine is already registered.');
    this.engines.set(engine.kind, engine);
  }

  /**
   * Retrieve the adapter selected for a new session.
   *
   * Args:
   *   kind (Engine): Requested public execution engine.
   * Returns:
   *   BrowserEngine: Registered adapter.
   */
  get(kind: Engine): BrowserEngine {
    const engine = this.engines.get(kind);
    // Report unavailable engines without selecting a replacement adapter.
    if (!engine)
      throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Requested engine is unavailable.');
    return engine;
  }

  /**
   * Return the identities of explicitly registered adapters.
   *
   * Args:
   *   None.
   * Returns:
   *   Engine[]: Registered public engine identities.
   */
  kinds(): Engine[] {
    return [...this.engines.keys()];
  }
}
