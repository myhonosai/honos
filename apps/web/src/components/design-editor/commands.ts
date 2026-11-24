import type { CreativeDesign, CreativeDesignStatus, SaveCreativeDesignInput } from '@hon/contracts';
import type { EditorApi } from './editor';
import { DesignsUnknown, type DesignsScope } from './http';

/**
 * What a create or status command means for the page when it answers.
 * `stale`: the page's privacy generation ended while the command was out (session end, school change, the page
 * closed). The answer is dropped whole: nothing is shown, no retry key is kept or cleared, no reload is asked for.
 */
export type DesignCommandOutcome =
  | { kind: 'saved'; design: CreativeDesign }
  | { kind: 'failed'; error: unknown }
  | { kind: 'stale' };

/**
 * The Designs page's create and status commands, bound to a privacy generation (security review 2026-11-22).
 *
 * Each command records the generation and the exact organization + school it was sent for. `retire()` starts a new
 * generation and forgets every retry key, so a slow answer from before a security event can neither reopen a
 * retired design nor restore or delete a retry key that now belongs to newer state. A retry key is only ever
 * cleared by the command that still owns it.
 */
export class DesignCommands {
  private generation = 0;
  private pending: { fingerprint: string; key: string } | null = null;
  private readonly statusKeys = new Map<string, string>();

  constructor(private readonly api: Pick<EditorApi, 'save' | 'setStatus'>, private readonly newKey: () => string = () => crypto.randomUUID()) {}

  /** End the current generation: called on every shell privacy event, school change and unmount. */
  retire(): void {
    ++this.generation;
    this.pending = null;
    this.statusKeys.clear();
  }

  /** The retry key a create would use right now (for tests and diagnostics; never shown). */
  pendingCreateKey(): string | null { return this.pending?.key ?? null; }
  pendingStatusKeys(): number { return this.statusKeys.size; }

  async create(scope: DesignsScope, input: SaveCreativeDesignInput): Promise<DesignCommandOutcome> {
    const owner = this.generation;
    const fingerprint = JSON.stringify([scope.organizationId, scope.schoolId, input.name, input.sizeCode, input.document]);
    if (this.pending?.fingerprint !== fingerprint) this.pending = { fingerprint, key: this.newKey() };
    const key = this.pending.key;
    try {
      const receipt = await this.api.save(scope, input, key);
      if (owner !== this.generation) return { kind: 'stale' };
      if (this.pending?.key === key) this.pending = null;
      return { kind: 'saved', design: receipt.design };
    } catch (error) {
      if (owner !== this.generation) return { kind: 'stale' };
      // An unknown outcome keeps its key so pressing again replays it instead of making a second design.
      if (!(error instanceof DesignsUnknown) && this.pending?.key === key) this.pending = null;
      return { kind: 'failed', error };
    }
  }

  async setStatus(scope: DesignsScope, row: { designId: string; version: number }, next: CreativeDesignStatus): Promise<DesignCommandOutcome> {
    const owner = this.generation;
    const id = `${scope.organizationId}:${scope.schoolId}:${row.designId}:${row.version}:${next}`;
    const key = this.statusKeys.get(id) ?? this.newKey();
    this.statusKeys.set(id, key);
    try {
      const receipt = await this.api.setStatus(scope, { designId: row.designId, expectedVersion: row.version, status: next }, key);
      if (owner !== this.generation) return { kind: 'stale' };
      if (this.statusKeys.get(id) === key) this.statusKeys.delete(id);
      return { kind: 'saved', design: receipt.design };
    } catch (error) {
      if (owner !== this.generation) return { kind: 'stale' };
      if (!(error instanceof DesignsUnknown) && this.statusKeys.get(id) === key) this.statusKeys.delete(id);
      return { kind: 'failed', error };
    }
  }
}
