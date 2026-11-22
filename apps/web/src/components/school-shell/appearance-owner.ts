/**
 * Appearance ownership (review [20]). The shell's personal view preference is read and saved for one verified
 * school. Every read or save is owned by the newest begin() for the scope that is still selected: a newer read or
 * save, a different school, or a concealment (session end, school change) retires it, so its answer can never set
 * the mode or claim a SAVED state that no longer belongs to the person and school on screen.
 */
export type AppearanceScope = Readonly<{ organizationId: string; schoolId: string }>;

const same = (a: AppearanceScope | null, b: AppearanceScope): boolean =>
  !!a && a.organizationId.toLowerCase() === b.organizationId.toLowerCase() && a.schoolId.toLowerCase() === b.schoolId.toLowerCase();

export class AppearanceOwner {
  private generation = 0;
  private selected: AppearanceScope | null = null;
  /** The verified school now on screen, or null while none is. Retires every read and save still out. */
  select(scope: AppearanceScope | null): void {
    this.generation += 1;
    this.selected = scope ? Object.freeze({ organizationId: scope.organizationId, schoolId: scope.schoolId }) : null;
  }
  retire(): void { this.select(null); }
  /** Starts a read or save for `scope`; the returned check is true only while it is the newest one for the selected school. */
  begin(scope: AppearanceScope): () => boolean {
    const generation = ++this.generation;
    const owned = Object.freeze({ organizationId: scope.organizationId, schoolId: scope.schoolId });
    return () => generation === this.generation && same(this.selected, owned);
  }
}
