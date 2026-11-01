import { createHmac, randomBytes } from 'node:crypto';

// Process-local defense in depth, never an authorization source. No IP/forwarded header trust,
// plaintext identity, invitation token, persistent claim or unbounded key/queue allocation.
export class SchoolAccountRateLimit {
  private readonly secret = randomBytes(32);
  private readonly subjects = new Map<string, number>();
  private start = -1;
  private total = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}
  admit(subject: string, operation: 'accept'|'invite'|'revoke'|'list'): number {
    const now = this.now();
    if (this.start < 0 || now - this.start >= 60_000) {
      this.start = now; this.total = 0; this.subjects.clear();
    }
    const key = createHmac('sha256', this.secret).update(operation === 'accept' ? 'accept:' : 'hq:').update(subject).digest('hex');
    const count = this.subjects.get(key) ?? 0;
    const wait = Math.max(1, Math.ceil((60_000 - (now - this.start)) / 1000));
    // Refuse saturation, never evict live counters and let identity churn reset a quota.
    if (this.total >= 300 || count >= (operation === 'accept' ? 10 : 30)
      || (!this.subjects.has(key) && this.subjects.size >= 512)) return wait;
    this.total++; this.subjects.set(key, count + 1);
    return 0;
  }
}
