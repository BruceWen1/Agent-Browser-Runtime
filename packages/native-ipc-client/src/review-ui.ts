// -*- coding: utf-8 -*-
/**
 * review-ui.ts
 * Independent approval process supervisor
 * =====================
 * Bind an OS user decision to exact pending operation identifiers and payload digest.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface LocalReview {
  id: string;
  sessionId: string;
  requestId: string;
  action: string;
  origin: string;
  digest: string;
  expiresAt: string;
}

/** ReviewUi supervises separate OS decision surfaces with bounded pending process ownership. */
export class ReviewUi {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();

  /**
   * Bind review processing to a locally built native executable.
   * Args:
   *   executable (string): Trusted desktop agent executable.
   * Returns:
   *   ReviewUi: Independent user decision provider.
   */
  constructor(private readonly executable: string) {}

  /**
   * Display an exact pending operation and wait for the local user's OS decision.
   * Args:
   *   review (LocalReview): Bounded action identity and origin metadata.
   * Returns:
   *   Promise<boolean>: Explicit approve or deny decision.
   */
  async decide(review: LocalReview): Promise<boolean | undefined> {
    if (this.children.size >= 4 || Date.parse(review.expiresAt) <= Date.now()) return undefined;
    const child = spawn(this.executable, ['--review'], { stdio: 'pipe', windowsHide: true });
    this.children.add(child);
    child.stderr.resume();
    child.stdin.on('error', () => child.kill());
    const { expiresAt, ...metadata } = review;
    // Supply exact review identity through inherited input exclusively.
    child.stdin.end(JSON.stringify(metadata));
    return new Promise<boolean | undefined>((resolve) => {
      let output = '';
      const timer = setTimeout(
        () => child.kill(),
        Math.min(300000, Date.parse(expiresAt) - Date.now()),
      );
      child.stdout.on('data', (bytes: Buffer) => {
        output += bytes.toString('utf8');
        if (output.length > 4096) child.kill();
      });
      child.once('error', () => {
        clearTimeout(timer);
        this.children.delete(child);
        resolve(undefined);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        // Accept only a successful exact-ID boolean decision from the owned process.
        try {
          const decision = JSON.parse(output) as { id: string; approved: boolean };
          if (
            code === 0 &&
            decision.id === review.id &&
            typeof decision.approved === 'boolean' &&
            Object.keys(decision).length === 2 &&
            Date.parse(expiresAt) > Date.now()
          )
            resolve(decision.approved);
          else resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
  }

  /**
   * Terminate every owned decision process during application shutdown.
   * Args:
   *   None.
   * Returns:
   *   void: Completion of decision process cancellation.
   */
  close(): void {
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
