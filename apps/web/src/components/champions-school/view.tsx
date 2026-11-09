import React from 'react';
import type {
  ChampionsDisplayMode, ChampionsSchoolContests, ChampionsSchoolLeaderboard, ChampionsSchoolRewards, ChampionsSchoolStatistics, ChampionsSchoolView,
  ChampionsSchoolReward, ChampionsSchoolStanding,
} from '@hon/contracts';
import { championsText, type ChampionsKey } from './copy';
import type { ChampionsErrorKind } from './http';
import styles from './champions-school.module.css';

type T = (key: ChampionsKey, vars?: Record<string, string>) => string;
export type ChampionsRead<V> = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'MISSING' }> | Readonly<{ state: 'READY'; value: V }>;
export type BoardPeriod = 'ALL_TIME' | 'MONTH';
export type ChampionsAction = 'code' | 'display';
export type ChampionsOutcome = null | Readonly<{
  kind: 'SENDING' | 'DONE' | Exclude<ChampionsErrorKind, 'SESSION'>; action: ChampionsAction;
  created?: boolean; replayed?: boolean; mode?: ChampionsDisplayMode;
}>;
export type CopyState = 'IDLE' | 'COPIED' | 'FAILED';

export type ChampionsSchoolViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  summary: ChampionsRead<ChampionsSchoolView>; statistics: ChampionsRead<ChampionsSchoolStatistics>; rewards: ChampionsRead<ChampionsSchoolRewards>;
  contests: ChampionsRead<ChampionsSchoolContests>; board: ChampionsRead<ChampionsSchoolLeaderboard>; period: BoardPeriod;
  outcome: ChampionsOutcome; locked: boolean; canRetry: boolean; copy: CopyState;
  onRefresh?: (() => void) | undefined; onIssueCode?: (() => void) | undefined; onCopy?: (() => void) | undefined;
  onPeriod?: ((period: BoardPeriod) => void) | undefined; onDisplay?: ((mode: ChampionsDisplayMode) => void) | undefined;
  onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined;
}>;

const MODES: readonly ChampionsDisplayMode[] = ['ANONYMOUS', 'SCHOOL_NAME'];
const COUNTS = ['PENDING', 'QUALIFIED', 'REJECTED', 'REFUNDED', 'REVERSED'] as const;
const moment = (language: string, iso: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
const usd = (language: string, minor: number) => new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' }).format(minor / 100);
const tierName = (tier: string) => tier.charAt(0) + tier.slice(1).toLowerCase();

/** One card's read state; READY renders the body. */
function ReadState<V>({ read, t, children }: { read: ChampionsRead<V>; t: T; children: (value: V) => React.ReactNode }) {
  if (read.state === 'READY') return <>{children(read.value)}</>;
  const key: ChampionsKey = read.state === 'LOADING' ? 'loading' : read.state === 'DENIED' ? 'denied' : read.state === 'MISSING' ? 'missing' : 'unavailable';
  return <p className={styles.meta} role="status">{t(key)}</p>;
}

function rewardText(r: ChampionsSchoolReward, language: string, t: T): string {
  const what = r.creditMinor !== null ? t('rewardCredit', { amount: usd(language, r.creditMinor) })
    : r.freeMonths !== null ? t('rewardMonths', { n: String(r.freeMonths) })
    : r.lifetimeTier !== null ? t('rewardLifetime', { tier: tierName(r.lifetimeTier) }) : t(`rw_${r.rewardKind}`);
  const at = r.milestoneCount !== null ? ` ${t('rewardAt', { count: String(r.milestoneCount) })}` : '';
  return `${t(`rw_${r.rewardKind}`)}: ${what}${at}, ${t('rewardRecorded', { date: moment(language, r.accruedAt) })}`;
}

function Standings({ rows, t, label }: { rows: readonly Pick<ChampionsSchoolStanding, 'rank' | 'displayName' | 'anonymous' | 'qualifiedReferrals' | 'isYou'>[]; t: T; label: string }) {
  if (rows.length === 0) return <p className={styles.meta}>{t('noStandings')}</p>;
  return <div className={styles.tableWrap}><table className={styles.table} aria-label={label}>
    <thead><tr><th scope="col">{t('rank')}</th><th scope="col">{t('school')}</th><th scope="col">{t('qualified')}</th></tr></thead>
    <tbody>{rows.map((s, i) => <tr key={`${s.rank}-${i}`} data-you={s.isYou ? 'true' : undefined} data-testid="champions-standing">
      <td>{s.rank}</td>
      <td>{s.anonymous || s.displayName === null ? t('anonymous') : s.displayName}{s.isYou ? <span className={styles.chip} data-kind="you">{t('you')}</span> : null}</td>
      <td>{s.qualifiedReferrals}</td>
    </tr>)}</tbody>
  </table></div>;
}

function outcomeText(o: NonNullable<ChampionsOutcome>, t: T): string {
  if (o.kind === 'SENDING') return t('sending');
  if (o.kind !== 'DONE') return t(`e_${o.kind}`);
  const done = o.action === 'code' ? t(o.created === false ? 'doneCodeExisting' : 'doneCode') : t('doneDisplay', { mode: t(`d_${o.mode ?? 'ANONYMOUS'}`) });
  return o.replayed ? `${done} ${t('replayed')}` : done;
}

/**
 * Champions Club for the verified school: referral code, program status, referral counts, milestones and recorded rewards,
 * the leaderboard (all time or this UTC month) with the school's display choice, contests and recent referral changes.
 * Pure view; every value comes from a verified read and every button only asks.
 */
export function ChampionsSchoolView(p: ChampionsSchoolViewProps): React.ReactElement {
  const t: T = (key, vars) => championsText(p.language, key, vars);
  const notice = p.waiting ? t('waiting') : p.concealed ? t('concealed') : !p.hasSchool ? t('noSchool') : null;
  const board = p.board.state === 'READY' && p.board.value.period === p.period ? p.board : p.board.state === 'READY' ? { state: 'LOADING' } as const : p.board;
  return <section className={styles.page} aria-labelledby="champions-title" data-hon-native="" data-testid="champions-school">
    <header className={styles.head}>
      <div><h1 id="champions-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {notice === null && p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={p.locked}>{t('refresh')}</button> : null}
    </header>
    <p className={styles.meta}>{t('scope')}</p>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : <>
      {p.outcome ? <div className={styles.notice} role="status" data-testid="champions-outcome" data-kind={p.outcome.kind}
        data-tone={p.outcome.kind === 'DONE' ? 'ok' : p.outcome.kind === 'SENDING' || p.outcome.kind === 'UNKNOWN' ? 'waiting' : 'blocked'}>
        <p>{outcomeText(p.outcome, t)}</p>
        {p.canRetry ? <div className={styles.row}>
          {p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
          {p.onStop ? <button type="button" className={styles.secondary} onClick={p.onStop}>{t('stop')}</button> : null}
        </div> : null}
      </div> : null}

      <div className={styles.grid}>
        <article className={styles.card} aria-labelledby="champions-code-title" data-testid="champions-code">
          <h2 id="champions-code-title">{t('codeTitle')}</h2>
          <ReadState read={p.summary} t={t}>{(s) => <>
            {s.referralCode ? <>
              <p className={styles.code} data-testid="champions-code-value">{s.referralCode.code}</p>
              <p className={styles.meta}>{t('codeIssued', { date: moment(p.language, s.referralCode.issuedAt) })}</p>
              <div className={styles.row}>
                <button type="button" className={styles.secondary} onClick={p.onCopy}>{t('copy')}</button>
                {p.copy === 'COPIED' ? <span className={styles.meta} role="status">{t('copied')}</span> : p.copy === 'FAILED' ? <span className={styles.meta} role="status">{t('copyFailed')}</span> : null}
              </div>
            </> : <>
              <p>{t('codeNone')}</p>
              <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked} onClick={p.onIssueCode} data-testid="champions-code-create">{t('codeCreate')}</button></div>
            </>}
            <p className={styles.meta}>{t('codeHelp')}</p>
          </>}</ReadState>
        </article>

        <article className={styles.card} aria-labelledby="champions-program-title" data-testid="champions-program">
          <h2 id="champions-program-title">{t('countsTitle')}</h2>
          <ReadState read={p.summary} t={t}>{(s) => <>
            <dl className={styles.counts}>{COUNTS.map((k) => <div key={k} data-testid={`champions-count-${k}`}>
              <dt>{t(`s_${k}`)}</dt><dd>{s.referrals[k.toLowerCase() as Lowercase<typeof k>]}</dd></div>)}</dl>
            <h3>{t('programTitle')}</h3>
            <p className={styles.meta}>{s.program.status === 'PUBLISHED' ? t('programPublished', { v: String(s.program.policyVersion ?? '') }) : t('programUndecided')}</p>
            <p className={styles.meta}>{t('rewardsInactive')}</p>
          </>}</ReadState>
        </article>
      </div>

      <article className={styles.card} aria-labelledby="champions-rewards-title" data-testid="champions-rewards">
        <h2 id="champions-rewards-title">{t('milestonesTitle')}</h2>
        <ReadState read={p.rewards} t={t}>{(r) => <>
          <p>{r.nextMilestone ? t('nextMilestone', { n: String(r.nextMilestone.remaining), reward: t(`rw_${r.nextMilestone.rewardKind}`), count: String(r.nextMilestone.milestoneCount) }) : t('noNextMilestone')}</p>
          {p.statistics.state === 'READY' && p.statistics.value.milestones.reached.length > 0 ? <ul className={styles.list}>
            {p.statistics.value.milestones.reached.map((m, i) => <li key={`${m.rewardKind}-${m.milestoneCount}-${i}`}>{t('reached', { reward: t(`rw_${m.rewardKind}`), count: String(m.milestoneCount) })}</li>)}
          </ul> : null}
          <h3>{t('rewardsTitle')}</h3>
          {r.rewards.length === 0 ? <p className={styles.meta}>{t('noRewards')}</p>
            : <ul className={styles.list}>{r.rewards.map((x, i) => <li key={`${x.rewardKind}-${x.accruedAt}-${i}`} data-testid="champions-reward">
              <span>{rewardText(x, p.language, t)}</span><span className={styles.chip} data-state={x.status}>{t(`rs_${x.status}`)}</span></li>)}</ul>}
          <p className={styles.meta}>{t('rewardsInactive')}</p>
        </>}</ReadState>
      </article>

      <article className={styles.card} aria-labelledby="champions-board-title" data-testid="champions-board">
        <h2 id="champions-board-title">{t('boardTitle')}</h2>
        <nav className={styles.tabs} aria-label={t('boardTitle')}>{(['ALL_TIME', 'MONTH'] as const).map((k) =>
          <button key={k} type="button" className={styles.tab} aria-pressed={p.period === k} onClick={() => p.onPeriod?.(k)} data-testid={`champions-period-${k}`}>{t(k === 'ALL_TIME' ? 'allTime' : 'thisMonth')}</button>)}</nav>
        <ReadState read={board} t={t}>{(b) => <>
          <p data-testid="champions-you">{b.you.status === 'RANKED' && b.you.rank !== null ? t('youRanked', { rank: String(b.you.rank), n: String(b.you.qualifiedReferrals) }) : t('youNotRanked', { n: String(b.you.qualifiedReferrals) })}</p>
          <Standings rows={b.standings} t={t} label={t('boardTitle')}/>
          <form key={b.you.displayMode} className={styles.form} data-testid="champions-display" onSubmit={(e) => {
            e.preventDefault();
            const mode = new FormData(e.currentTarget).get('displayMode');
            if (mode === 'ANONYMOUS' || mode === 'SCHOOL_NAME') p.onDisplay?.(mode);
          }}>
            <fieldset className={styles.fieldset} disabled={p.locked}><legend>{t('displayTitle')}</legend>
              {MODES.map((m) => <label key={m} className={styles.check}><input type="radio" name="displayMode" value={m} defaultChecked={b.you.displayMode === m}/>{t(`d_${m}`)}</label>)}
            </fieldset>
            <p className={styles.meta}>{t('displayHelp')}</p>
            <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{t('displaySave')}</button></div>
          </form>
        </>}</ReadState>
      </article>

      <article className={styles.card} aria-labelledby="champions-contests-title" data-testid="champions-contests">
        <h2 id="champions-contests-title">{t('contestsTitle')}</h2>
        <ReadState read={p.contests} t={t}>{(c) => c.contests.length === 0 ? <p className={styles.meta}>{t('noContests')}</p> : <ul className={styles.contests}>
          {c.contests.map((x) => <li key={x.contestId} data-testid="champions-contest">
            <div className={styles.cardHead}><h3>{x.name}</h3><span className={styles.chip} data-state={x.status}>{t(`c_${x.status}`)}</span></div>
            <p className={styles.meta}>{t('contestWindow', { from: moment(p.language, x.startsAt), to: moment(p.language, x.endsAt) })}</p>
            {x.description ? <p>{x.description}</p> : null}
            <p>{t('contestYou', { n: String(x.you.qualifiedReferrals) })}{x.you.rank !== null ? ` · ${t('contestRank', { rank: String(x.you.rank) })}` : ''}</p>
            {x.won ? <p className={styles.won}>{t('won')}</p> : null}
            <p className={styles.meta}>{t('contestMin', { n: String(x.minimumQualified) })}</p>
            {x.prizes.length > 0 ? <><h4>{t('prizes')}</h4><ul className={styles.list}>{x.prizes.map((z, i) =>
              <li key={i}>{t(z.placeFrom === z.placeTo ? 'prizePlace' : 'prizePlaces', { from: String(z.placeFrom), to: String(z.placeTo), description: z.description })}</li>)}</ul></> : null}
            <Standings rows={x.standings} t={t} label={x.name}/>
          </li>)}
        </ul>}</ReadState>
      </article>

      <article className={styles.card} aria-labelledby="champions-history-title" data-testid="champions-history">
        <h2 id="champions-history-title">{t('historyTitle')}</h2>
        <ReadState read={p.statistics} t={t}>{(s) => s.history.length === 0 ? <p className={styles.meta}>{t('noHistory')}</p> : <ul className={styles.list}>
          {s.history.map((h, i) => <li key={`${h.occurredAt}-${i}`} data-testid="champions-history-row">
            <span>{t('historyRow', { from: h.fromState ? t(`s_${h.fromState}`) : t('fromNone'), to: t(`s_${h.toState}`), reason: t(`r_${h.reason}`) })}</span>
            <span className={styles.meta}>{moment(p.language, h.occurredAt)}</span></li>)}
        </ul>}</ReadState>
      </article>
    </>}
  </section>;
}
