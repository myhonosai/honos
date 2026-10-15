import { HqAccessIndicator } from './hq-access-indicator';
import { HqOnboardingPanel } from './hq-onboarding-panel';

const hqAreas = [
  ['Growth', 'Prospects, onboarding, activation, retention, expansion'],
  ['Customers', 'Organizations, schools, health, success, support'],
  ['Revenue', 'Subscriptions, billing posture, provider reconciliation'],
  ['AI Economics', 'Credits, provider cost, utilization, safeguards'],
  ['Product & Platform', 'Rollouts, incidents, provider health, observability'],
  ['Finance & Analytics', 'Unit economics, operating evidence, decisions'],
] as const;

export function HqControlPlane(): React.ReactElement {
  return (
    <main className="hq-shell">
      <aside className="hq-rail">
        <a href="/" className="hq-back">← School OS</a>
        <div className="hq-brand"><span>HON</span><strong>HQ</strong><small>Growth & Operations</small></div>
        <div className="hq-role-gate"><span>ACCESS GATE</span><strong>HON HQ owner or operator required</strong><p>HQ is separate from school roles. School permissions never become HQ permissions.</p></div>
        <nav aria-label="HON HQ navigation">{hqAreas.map(([title], index) => <a key={title} href={`#${title.toLowerCase().replaceAll(' ', '-')}`}><span>{String(index + 1).padStart(2, '0')}</span>{title}</a>)}</nav>
      </aside>
      <section className="hq-workspace">
        <header className="hq-header"><div><p>HON HQ / PRIVILEGED CONTROL PLANE</p><h1>Operate HON.<br />Never bypass the schools.</h1></div><div className="hq-session"><HqAccessIndicator /><small>HQ API gate: <code>/v1/hq/session</code></small></div></header>
        <section className="hq-banner"><div><span className="hq-pulse" />HQ is designed as an owner workspace—not a school dashboard.</div><p>Use it to market, onboard, support, retain, expand, measure, and safely operate the HON platform. School data remains tenant-scoped and impersonation is a future auditable, time-bounded capability.</p></section>
        <section className="hq-metric-strip"><article><span>CONTROL PLANE</span><strong>Separate authorization</strong><small>HQ role resolution is independent of school grants.</small></article><article><span>DATA POSTURE</span><strong>Tenant scope stays enforced</strong><small>No cross-school data is exposed by the initial dashboard.</small></article><article><span>TEST ACCESS</span><strong>Account binding required</strong><small>First owner is provisioned only by the privileged bootstrap step.</small></article></section>
        <HqOnboardingPanel />
        <section className="hq-grid">{hqAreas.map(([title, detail], index) => <article id={title.toLowerCase().replaceAll(' ', '-')} className="hq-card" key={title}><span className={`hq-index hq-index-${index}`}>{String(index + 1).padStart(2, '0')}</span><h2>{title}</h2><p>{detail}</p><button disabled type="button">Awaiting HQ session scope <span>→</span></button></article>)}</section>
        <section className="hq-test-panel"><div><p>OWNER TEST PATH</p><h2>Sign in → provision verified identity → confirm HQ session → test staged capabilities.</h2></div><ol><li>Application identity is verified.</li><li>HQ operator grant resolves through a security-definer boundary.</li><li>Each HQ capability receives its own permission and audit policy.</li></ol></section>
      </section>
    </main>
  );
}
