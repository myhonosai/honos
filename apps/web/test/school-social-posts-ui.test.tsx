import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SocialAccount, SocialPost, SocialPostList, SocialPostTarget } from '@hon/contracts';
import { POSTS_LANGUAGES } from '../src/components/school-social-posts/copy';
import { POSTS_BACK_DAYS, PostsError, keepPostsForRetry, postsApi, postsErrorFor, publishAtFrom } from '../src/components/school-social-posts/http';
import { EMPTY_FORM, PostsView, canTakePosts, cancellable, textLimit, type PostsViewProps } from '../src/components/school-social-posts/view';
import { schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const at = '2026-11-24T05:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const account = (over: Partial<SocialAccount> = {}): SocialAccount => ({ accountId: id(40), platform: 'FACEBOOK', displayName: 'Synthetic Dojo Page', status: 'CONNECTED',
  publishEnabled: true, inboxEnabled: false, adsEnabled: false, version: 2, connectedAt: at, updatedAt: at, disconnectedAt: null, ...over });
const target = (over: Partial<SocialPostTarget> = {}): SocialPostTarget => ({ targetId: id(50), accountId: id(40), platform: 'FACEBOOK', displayName: 'Synthetic Dojo Page',
  status: 'PENDING', failureCode: null, skipReason: null, resolvedByPerson: false, settledAt: null, version: 1, ...over });
const post = (over: Partial<SocialPost> = {}): SocialPost => ({ postId: id(60), text: 'Free trial week starts Monday!', linkUrl: null, status: 'DRAFT', publishAt: null,
  accountIds: [id(40)], version: 1, createdAt: at, updatedAt: at, approvedAt: null, cancelledAt: null, targets: [], ...over });
const approved = (over: Partial<SocialPost> = {}, t: Partial<SocialPostTarget> = {}) => post({ status: 'APPROVED', publishAt: at, approvedAt: at, version: 2, targets: [target(t)], ...over });
const list = (over: Partial<SocialPostList> = {}): SocialPostList => ({ posts: [post()], publishEnabled: true, checkedAt: at, ...over });
const props = (over: Partial<PostsViewProps> = {}): PostsViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true,
  read: { state: 'READY', accounts: [account()], posts: list() }, form: EMPTY_FORM, approving: null, confirming: null, outcome: null, locked: false, canRetry: false, ...over });
const render = (over: Partial<PostsViewProps> = {}) => renderToStaticMarkup(<PostsView {...props(over)} />);

it('reads posts with a plain GET over a 100-day window from 30 days back', async () => {
  const f = stub(json({ data: list(), meta }));
  const out = await postsApi.list(scope, new Date(at), signal(), () => true);
  expect(out.posts).toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  const url = new URL(path, 'https://x');
  expect(url.pathname).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/social/posts`);
  expect([...url.searchParams.keys()].sort()).toEqual(['from', 'to']);
  const from = Date.parse(url.searchParams.get('from')!), to = Date.parse(url.searchParams.get('to')!);
  expect(Date.parse(at) - from).toBe(POSTS_BACK_DAYS * 86_400_000);
  expect(to - from).toBe(100 * 86_400_000);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
});

it('sends each write with its own command, key and exact body', async () => {
  const cases: [() => Promise<unknown>, string, string, unknown, unknown][] = [
    [() => postsApi.create(scope, { text: 'Hello', accountIds: [id(40)], linkUrl: 'https://dojo.example/trial' }, key, signal(), () => true), 'posts', 'marketing.social.post.create',
      { text: 'Hello', accountIds: [id(40)], linkUrl: 'https://dojo.example/trial' }, post({ text: 'Hello', linkUrl: 'https://dojo.example/trial' })],
    [() => postsApi.edit(scope, id(60), { text: 'Hello again', accountIds: [id(40)], expectedVersion: 1 }, key, signal(), () => true), `posts/${id(60)}`, 'marketing.social.post.edit',
      { text: 'Hello again', accountIds: [id(40)], expectedVersion: 1 }, post({ text: 'Hello again', version: 2 })],
    [() => postsApi.approve(scope, id(60), { expectedVersion: 1 }, key, signal(), () => true), `posts/${id(60)}/approve`, 'marketing.social.post.approve', { expectedVersion: 1 }, approved()],
    [() => postsApi.approve(scope, id(60), { expectedVersion: 1, publishAt: '2026-11-25T17:00:00.000Z' }, key, signal(), () => true), `posts/${id(60)}/approve`, 'marketing.social.post.approve',
      { expectedVersion: 1, publishAt: '2026-11-25T17:00:00.000Z' }, approved()],
    [() => postsApi.cancel(scope, id(60), 2, key, signal(), () => true), `posts/${id(60)}/cancel`, 'marketing.social.post.cancel', { expectedVersion: 2 },
      post({ status: 'CANCELLED', cancelledAt: at, version: 3 })],
    [() => postsApi.resolve(scope, id(50), { expectedVersion: 3, outcome: 'NOT_PUBLISHED' }, key, signal(), () => true), `post-targets/${id(50)}/resolve`, 'marketing.social.post.resolve',
      { expectedVersion: 3, outcome: 'NOT_PUBLISHED' }, approved({ version: 3 }, { status: 'FAILED', failureCode: 'CONFIRMED_NOT_PUBLISHED', resolvedByPerson: true, settledAt: at, version: 4 })],
  ];
  for (const [call, suffix, command, body, answer] of cases) {
    const g = stub(json({ data: answer, meta }));
    await call();
    const [gp, gi] = g.mock.calls[0] as unknown as [string, RequestInit];
    expect(gp).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/social/${suffix}`);
    expect(gi).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
    expect(gi.headers).toMatchObject({ 'X-HON-Human-Command': command, 'Idempotency-Key': key });
    expect(JSON.parse(gi.body as string)).toEqual(body);
  }
});

it('refuses bad input before sending, answers about another post or target, and maps refusals to closed kinds', async () => {
  const f = stub(json({ data: post(), meta }));
  for (const call of [
    () => postsApi.create(scope, { text: '', accountIds: [id(40)] }, key, signal(), () => true),
    () => postsApi.create(scope, { text: 'x', accountIds: [] }, key, signal(), () => true),
    () => postsApi.create(scope, { text: 'x', accountIds: [id(40)], linkUrl: 'http://plain.example' }, key, signal(), () => true),
    () => postsApi.create(scope, { text: 'x', accountIds: [id(40)] }, 'not-a-key', signal(), () => true),
    () => postsApi.approve(scope, 'not-an-id', { expectedVersion: 1 }, key, signal(), () => true),
  ]) expect(await call().catch((e: unknown) => e)).toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
  stub(json({ data: post({ postId: id(61) }), meta }));
  expect(await postsApi.edit(scope, id(60), { text: 'x', accountIds: [id(40)], expectedVersion: 1 }, key, signal(), () => true).catch((e: unknown) => e)).toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ data: approved({}, { targetId: id(51) }), meta }));
  expect(await postsApi.resolve(scope, id(50), { expectedVersion: 1, outcome: 'PUBLISHED' }, key, signal(), () => true).catch((e: unknown) => e)).toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ data: approved(), meta }));
  expect(await postsApi.create(scope, { text: 'x', accountIds: [id(40)] }, key, signal(), () => true).catch((e: unknown) => e)).toMatchObject({ kind: 'UNKNOWN' });
  const map: [number, string | null, string][] = [[403, 'SOCIAL_FORBIDDEN', 'DENIED'], [404, 'SOCIAL_POST_NOT_FOUND', 'GONE'], [429, null, 'LIMIT'],
    [422, 'SOCIAL_MEDIA_REQUIRED', 'MEDIA'], [400, 'SOCIAL_TEXT_TOO_LONG', 'TOO_LONG'], [400, 'SOCIAL_INVALID', 'INVALID'],
    [409, 'SOCIAL_POST_STATE', 'STATE'], [409, 'SOCIAL_PUBLISH_OFF', 'PUBLISH_OFF'], [409, 'SOCIAL_ACCOUNT_DISCONNECTED', 'PUBLISH_OFF'],
    [409, 'SOCIAL_VERSION_CONFLICT', 'STALE'], [409, 'IDEMPOTENCY_KEY_REUSED', 'INVALID'], [409, 'SOMETHING_NEW', 'UNKNOWN'], [500, null, 'UNKNOWN'], [503, null, 'UNKNOWN'], [422, null, 'UNKNOWN']];
  for (const [status, code, kind] of map) expect(postsErrorFor(status, code).kind, `${status} ${code}`).toBe(kind);
  expect(keepPostsForRetry(new PostsError('UNKNOWN'))).toBe(true);
  expect(keepPostsForRetry(new PostsError('STALE'))).toBe(false);
  expect(keepPostsForRetry(new Error('boom'))).toBe(true);
  stub(json({ code: 'SOCIAL_PUBLISH_OFF' }, 409));
  expect(await postsApi.approve(scope, id(60), { expectedVersion: 1 }, key, signal(), () => true).catch((e: unknown) => e)).toMatchObject({ kind: 'PUBLISH_OFF' });
  stub(new Response('<html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
  expect(await postsApi.approve(scope, id(60), { expectedVersion: 1 }, key, signal(), () => true).catch((e: unknown) => e)).toMatchObject({ kind: 'UNKNOWN' });
});

it('turns a picked local time into an ISO time only when it is in the future and at most 90 days ahead', () => {
  const now = new Date(at);
  const later = new Date(now.getTime() + 2 * 3_600_000);
  const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  expect(publishAtFrom(local(later), now)).toBe(new Date(local(later)).toISOString());
  expect(publishAtFrom(local(new Date(now.getTime() - 60_000)), now)).toBeNull();
  expect(publishAtFrom(local(new Date(now.getTime() + 91 * 86_400_000)), now)).toBeNull();
  for (const bad of ['', '2026-11-24', '2026-13-01T10:00', 'tomorrow', '2026-11-24T10:00:00Z']) expect(publishAtFrom(bad, now)).toBeNull();
});

it('offers only connected Facebook Pages and Google Business Profiles with posting on, and lowers the limit for Google', () => {
  const fb = account(), off = account({ accountId: id(41), publishEnabled: false, displayName: 'Second Page' }), ig = account({ accountId: id(42), platform: 'INSTAGRAM', displayName: 'dojo.ig' });
  const gbp = account({ accountId: id(43), platform: 'GOOGLE_BUSINESS', displayName: 'Dojo on Google' }), ads = account({ accountId: id(44), platform: 'GOOGLE_ADS', displayName: 'Dojo Ads' });
  const gone = account({ accountId: id(45), status: 'DISCONNECTED', publishEnabled: false, disconnectedAt: at, displayName: 'Old Page' });
  expect([fb, off, ig, gbp, ads, gone].map(canTakePosts)).toEqual([true, false, false, true, false, false]);
  expect(textLimit([fb, gbp], [id(40)])).toBe(2200);
  expect(textLimit([fb, gbp], [id(40), id(43)])).toBe(1500);
  const html = render({ read: { state: 'READY', accounts: [fb, off, ig, gbp, ads, gone], posts: list({ posts: [] }) }, form: { ...EMPTY_FORM, accountIds: [id(43)], text: 'x'.repeat(1600) } });
  expect(html).toContain(`data-posts-account="${id(40)}" data-usable="yes"`);
  expect(html).toContain(`data-posts-account="${id(41)}" data-usable="no"`);
  expect(html).toContain(`data-posts-account="${id(42)}" data-usable="no"`);
  expect(html).toContain(`data-posts-account="${id(43)}" data-usable="yes"`);
  expect(html).not.toContain(id(44));
  expect(html).not.toContain(id(45));
  expect(html).toContain('Instagram needs a photo');
  expect(html).toContain('Posting switch is off');
  expect(html).toContain('1600 of 1500 characters');
  // Over the limit, the save button is off.
  expect(html).toMatch(/<button type="button" class="[^"]*" disabled="">Save draft<\/button>/);
});

it('says when posting is off, and points to Social accounts when no account can take posts', () => {
  const off = render({ read: { state: 'READY', accounts: [account()], posts: list({ publishEnabled: false }) } });
  expect(off).toContain('data-posts-publish-off');
  expect(off).toContain('approved posts wait and nothing is posted');
  expect(render()).not.toContain('data-posts-publish-off');
  const none = render({ read: { state: 'READY', accounts: [account({ publishEnabled: false })], posts: list({ posts: [] }) } });
  expect(none).toContain('data-posts-no-accounts');
  expect(none).toContain('href="/staff/marketing/social"');
  expect(none).not.toContain('data-posts-composer');
});

it('shows the right actions for drafts, approved posts and unknown targets', () => {
  expect(cancellable(post())).toBe(true);
  expect(cancellable(approved())).toBe(true);
  expect(cancellable(approved({}, { status: 'PUBLISHING' }))).toBe(false);
  expect(cancellable(post({ status: 'CANCELLED', cancelledAt: at }))).toBe(false);
  const draft = render();
  expect(draft).toContain('>Edit<'); expect(draft).toContain('>Approve<'); expect(draft).toContain('>Cancel post<');
  const approving = render({ approving: { postId: id(60), mode: 'LATER', at: '' } });
  expect(approving).toContain(`data-posts-approve="${id(60)}"`);
  expect(approving).toContain('type="datetime-local"');
  expect(approving).toMatch(/disabled="">Approve<\/button>/);
  const unknown = render({ read: { state: 'READY', accounts: [account()], posts: list({ posts: [approved({}, { status: 'UNKNOWN' })] }) } });
  expect(unknown).toContain('It was posted'); expect(unknown).toContain('It was not posted');
  expect(unknown).not.toContain('>Cancel post<');
  const failed = render({ read: { state: 'READY', accounts: [account()], posts: list({ posts: [approved({}, { status: 'FAILED', failureCode: 'PROVIDER_REJECTED', settledAt: at })] }) } });
  expect(failed).toContain('Not posted'); expect(failed).toContain('refused it');
  const confirm = render({ confirming: id(60) });
  expect(confirm).toContain('Cancel this post? Nothing is posted.');
});

it('reports outcomes, offers Try again only for a kept request, and hides everything while concealed', () => {
  expect(render({ outcome: { kind: 'DONE', action: 'approve' } })).toContain('Approved.');
  const unknown = render({ outcome: { kind: 'UNKNOWN', action: 'create' }, canRetry: true });
  expect(unknown).toContain('data-posts-outcome="UNKNOWN"'); expect(unknown).toContain('>Try again<');
  expect(render({ outcome: { kind: 'STALE', action: 'edit' } })).not.toContain('>Try again<');
  expect(render({ outcome: { kind: 'BAD_TIME', action: 'approve' } })).toContain('at most 90 days ahead');
  const hidden = render({ concealed: true });
  expect(hidden).not.toContain('Free trial week'); expect(hidden).toContain('Hidden while you were away');
  expect(render({ read: { state: 'DENIED' } })).toContain('cannot see this school');
  expect(render({ language: 'ko' })).toContain('게시물 작성');
  expect(render({ language: 'es' })).toContain('Escribir una publicación');
});

it('has every wording in all three languages and a nav route under Facebook & Instagram', () => {
  const keys = Object.keys(POSTS_LANGUAGES.en).sort();
  expect(Object.keys(POSTS_LANGUAGES.ko).sort()).toEqual(keys);
  expect(Object.keys(POSTS_LANGUAGES.es).sort()).toEqual(keys);
  for (const table of Object.values(POSTS_LANGUAGES)) for (const v of Object.values(table)) expect(v.trim().length).toBeGreaterThan(0);
  expect(schoolShellActiveRoute('/staff/marketing/social/posts')?.href).toBe('/staff/marketing/social/posts');
});
