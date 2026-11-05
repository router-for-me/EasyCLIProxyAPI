import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { I18nProvider, supportedLocales, translate } from '../src/i18n';
import { readRoutingBoard, validateRoutingPlan, type RoutingBoard, type RoutingMember } from '../src/services/routing';
import { RoutingPage } from '../src/pages/routing/RoutingPage';
import { PolicyStrip } from '../src/pages/routing/PolicyStrip';
import { TierLadder } from '../src/pages/routing/TierLadder';
import { assignTierPriorities, diffPlan, draftFromBoard, moveMember, resolveRoute, splitMember, stepMember, tiersFromMembers } from '../src/pages/routing/routingPlan';

const member = (key: string, priority = 0, overrides: Partial<RoutingMember> = {}): RoutingMember => ({
  key, name: key, family: 'codex', priority, weights: [null], disabled: false, unavailable: false, runtimeOnly: false, ...overrides,
});
const boardWith = (...members: RoutingMember[]): RoutingBoard => ({
  revision: 'revision', members, partial: [], groups: {},
  settings: { strategy: 'round-robin', session_affinity: false, session_affinity_ttl: '', request_retry: 0, max_retry_credentials: 0, max_retry_interval: 0, transient_error_cooldown_seconds: 0, disable_cooling: false },
});
const render = (content: ReactNode) => renderToStaticMarkup(<I18nProvider>{content}</I18nProvider>);

function ladder(board: RoutingBoard) {
  const draft = draftFromBoard(board);
  return render(<TierLadder board={board} draft={draft} tierPriorities={diffPlan(board, draft)!.tierPriorities} preview={resolveRoute(board, draft)} disabled={false} onChange={() => {}} />);
}

describe('routing tier arrangement', () => {
  it('groups priorities descending with stable peer ordering and clones draft data', () => {
    const board = boardWith(member('z', 0), member('b', 10), member('a', 10));
    const tiers = tiersFromMembers(board.members);
    expect(tiers.map(tier => tier.memberKeys)).toEqual([['a', 'b'], ['z']]);
    const draft = draftFromBoard(board);
    expect(diffPlan(board, draft)?.changes).toEqual([]);
    draft.weights.a[0] = 7;
    draft.settings.request_retry = 3;
    expect(board.members[2].weights).toEqual([null]);
    expect(board.settings.request_retry).toBe(0);
  });

  it('moves peers and splits in any gap without empty tiers or adjacent singleton churn', () => {
    const tiers = tiersFromMembers([member('a', 20), member('b', 20), member('c', 0)]);
    expect(moveMember(tiers, 'a', { kind: 'tier', tierId: tiers[1].id }).map(tier => tier.memberKeys)).toEqual([['b'], ['c', 'a']]);
    expect(moveMember(tiers, 'a', { kind: 'gap', index: 1 }).map(tier => tier.memberKeys)).toEqual([['b'], ['a'], ['c']]);
    expect(moveMember(tiers, 'c', { kind: 'gap', index: 1 })).toEqual(tiers);
    expect(moveMember(tiers, 'c', { kind: 'gap', index: 2 })).toEqual(tiers);
    expect(moveMember(tiers, 'missing', { kind: 'gap', index: 0 })).toEqual(tiers);
    expect(moveMember(tiers, 'a', { kind: 'tier', tierId: 'missing' })).toEqual(tiers);
    expect(tiers[0].memberKeys).toEqual(['a', 'b']);
  });

  it('supports quick steps and splitting above or below peers', () => {
    const tiers = tiersFromMembers([member('a', 10), member('b', 10), member('c', 0)]);
    expect(stepMember(tiers, 'a', 'up').map(tier => tier.memberKeys)).toEqual([['a'], ['b'], ['c']]);
    expect(stepMember(tiers, 'a', 'down').map(tier => tier.memberKeys)).toEqual([['b'], ['c', 'a']]);
    expect(stepMember(tiers, 'c', 'up').map(tier => tier.memberKeys)).toEqual([['a', 'b', 'c']]);
    expect(splitMember(tiers, 'a', 'above').map(tier => tier.memberKeys)).toEqual([['a'], ['b'], ['c']]);
    expect(splitMember(tiers, 'a', 'below').map(tier => tier.memberKeys)).toEqual([['b'], ['a'], ['c']]);
  });

  it('preserves stored priorities and spaces new end tiers by ten', () => {
    const board = boardWith(member('a'), member('b'));
    const draft = draftFromBoard(board);
    const original = new Map(board.members.map(item => [item.key, item.priority]));
    expect(assignTierPriorities(draft.tiers, original)).toEqual([0]);
    expect(assignTierPriorities(splitMember(draft.tiers, 'a', 'above'), original)).toEqual([10, 0]);
    expect(assignTierPriorities([{ id: 'top', memberKeys: ['x'] }, ...draft.tiers, { id: 'bottom', memberKeys: ['y'] }], original)).toEqual([10, 0, -10]);
    expect(assignTierPriorities([{ id: 'a', memberKeys: ['x'] }, { id: 'b', memberKeys: ['y'] }], new Map())).toEqual([10, 0]);
  });

  it('interpolates tight gaps, respects fixed priorities and int32 boundaries', () => {
    const tiers = [{ id: 'top', memberKeys: ['a'] }, { id: 'new', memberKeys: ['b'] }, { id: 'bottom', memberKeys: ['c'] }];
    const fixed = new Map([['a', 2], ['c', 0]]);
    expect(assignTierPriorities(tiers, fixed, fixed)).toEqual([2, 1, 0]);
    expect(assignTierPriorities(tiers, new Map([['a', 1], ['c', 0]]), new Map([['a', 1], ['c', 0]]))).toBeNull();
    expect(assignTierPriorities([{ id: 'a', memberKeys: ['a', 'c'] }], fixed, fixed)).toBeNull();
    expect(assignTierPriorities(tiers, new Map([['a', 2147483647]]), new Map([['a', 2147483647]]))).toEqual([2147483647, 2147483637, 2147483627]);
    expect(assignTierPriorities(tiers, new Map([['c', -2147483648]]), new Map([['c', -2147483648]]))).toEqual([-2147483628, -2147483638, -2147483648]);
  });

  it('reports each modified setting, weight and priority and creates a valid service plan', () => {
    const board = boardWith(member('a'), member('b'));
    const draft = draftFromBoard(board);
    draft.tiers = splitMember(draft.tiers, 'a', 'above');
    draft.weights.a = [3];
    draft.settings.strategy = 'weighted-round-robin';
    const diff = diffPlan(board, draft)!;
    expect(diff.changes).toEqual([
      { key: 'a', kind: 'priority', from: 0, to: 10 },
      { key: 'a', kind: 'weight', field: '0', from: null, to: 3 },
      { key: 'settings', kind: 'setting', field: 'strategy', from: 'round-robin', to: 'weighted-round-robin' },
    ]);
    expect(() => validateRoutingPlan(board, diff.plan)).not.toThrow();
    expect(diff.plan.revision).toBe(board.revision);
    const fixed = boardWith(member('fixed', 0, { runtimeOnly: true }));
    const fixedDraft = draftFromBoard(fixed);
    fixedDraft.weights.fixed = [5];
    expect(diffPlan(fixed, fixedDraft)).toBeNull();
    expect(diffPlan(board, { ...draft, tiers: [] })).toBeNull();
  });
});

describe('routing traffic preview', () => {
  it('marks the first usable tier primary, lower tiers standby, and unusable tiers skipped', () => {
    const board = boardWith(member('off', 30, { disabled: true }), member('blocked', 20, { unavailable: true }), member('a', 10), member('b', 10), member('c', 0));
    const preview = resolveRoute(board, draftFromBoard(board));
    expect(preview.steps.map(step => [step.step, step.isPrimary])).toEqual([[1, true], [2, false]]);
    expect(preview.steps[0].members.map(item => item.share)).toEqual([0.5, 0.5]);
    expect(preview.steps[1].members[0]).toEqual({ key: 'c', state: 'standby', share: 1 });
    expect(preview.states.get('off')).toBe('ineligible');
    expect(preview.states.get('blocked')).toBe('blocked');
  });

  it('weights keys with inherited defaults, excludes zero totals, and ignores weights for round robin', () => {
    const board = boardWith(member('a', 0, { weights: [3, null], keyCount: 2 }), member('b', 0, { weights: [0] }), member('c', 0, { weights: [1] }));
    const draft = draftFromBoard(board);
    draft.settings.strategy = 'weighted-round-robin';
    const preview = resolveRoute(board, draft);
    expect(preview.steps[0].members.map(item => item.share)).toEqual([0.8, null, 0.2]);
    expect(preview.states.get('b')).toBe('excluded');
    draft.settings.strategy = 'round-robin';
    expect(resolveRoute(board, draft).steps[0].members.map(item => item.share)).toEqual([0.5, 0.25, 0.25]);
    draft.settings.strategy = 'fill-first';
    expect(resolveRoute(board, draft).steps[0].members.every(item => item.share === null)).toBe(true);
  });

  it('skips zero-weight tiers and returns an empty route when nothing can serve', () => {
    const board = boardWith(member('zero', 10, { weights: [0] }), member('fallback', 0));
    const draft = draftFromBoard(board);
    draft.settings.strategy = 'weighted-round-robin';
    expect(resolveRoute(board, draft).steps[0].members[0].key).toBe('fallback');
    draft.weights.fallback = [0];
    expect(resolveRoute(board, draft).steps).toEqual([]);
    expect(resolveRoute(boardWith(), draftFromBoard(boardWith())).steps).toEqual([]);
  });
});

describe('routing components', () => {
  it('renders the page toolbar and policy strategy selector without native selects', () => {
    const html = render(<RoutingPage />);
    expect(html).toContain('Apply plan');
    expect(html).toContain('Discard changes');
    const board = boardWith();
    const policy = render(<PolicyStrip settings={board.settings} disabled={false} onChange={() => {}} />);
    expect(policy).toContain('Gateway policy');
    expect(policy.match(/role="radio"/g)).toHaveLength(3);
    expect(policy).not.toContain('<select');
    expect(policy).toContain('∞');
    board.settings.session_affinity = true;
    expect(render(<PolicyStrip settings={board.settings} disabled onChange={() => {}} />)).toContain('placeholder="1h"');
  });

  it('validates session affinity ttl duration format', () => {
    const board = boardWith();
    board.settings.session_affinity = true;
    board.settings.session_affinity_ttl = '3';
    const invalidMarkup = render(<PolicyStrip settings={board.settings} disabled={false} onChange={() => {}} />);
    expect(invalidMarkup).toContain('routing-ttl-error');
    expect(invalidMarkup).toContain('role="alert"');

    board.settings.session_affinity_ttl = '1h30m';
    const validMarkup = render(<PolicyStrip settings={board.settings} disabled={false} onChange={() => {}} />);
    expect(validMarkup).not.toContain('routing-ttl-error');
    expect(validMarkup).not.toContain('role="alert"');
  });

  it('shows serving shares, standby status, metadata and quick tier controls', () => {
    const html = ladder(boardWith(member('a', 10, { kind: 'provider', prefix: 'team', keyCount: 2, weights: [null, null] }), member('b', 10, { kind: 'credential' }), member('c', 0, { runtimeOnly: true })));
    expect(html).toContain('Request entry');
    expect(html).toContain('Serving requests');
    expect(html).toContain('Standby:');
    expect(html).toContain('66.7%');
    expect(html).toContain('100%');
    expect(html).toContain('2 keys');
    expect(html).toContain('team/');
    expect(html).toContain('OAuth');
    expect(html).toContain('Fixed');
    expect(html).toContain('Alt+↑');
    expect(html).toContain('Split into a separate tier');
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('<select');
  });

  it('renders weight editors only for weighted routing and null shares for fill first', () => {
    const board = boardWith(member('a'), member('b', 0, { weights: [0] }));
    board.settings.strategy = 'weighted-round-robin';
    let html = ladder(board);
    expect(html).toContain('aria-label="Weight"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('×1');
    expect(html).toContain('Weight 0');
    board.settings.strategy = 'fill-first';
    board.settings.request_retry = 3;
    html = ladder(board);
    expect(html).not.toContain('type="number"');
    expect(html).toContain('Sequential takeover');
    expect(html).toContain('after 3 retry rounds');
    expect(ladder(boardWith())).toContain('No routing credentials');
  });

  it('translates routing state summaries in every supported locale', () => {
    for (const locale of supportedLocales) {
      expect(translate(locale, 'routing.changeCount', { count: 3 })).toContain('3');
      expect(translate(locale, 'routing.entrySummary', { count: 2, tiers: 1 })).not.toContain('{');
      expect(translate(locale, 'routing.serving')).not.toBe('routing.serving');
    }
  });

  it('translates routing review dialog copy in every supported locale', () => {
    for (const locale of supportedLocales) {
      expect(translate(locale, 'routing.reviewTitle')).not.toBe('routing.reviewTitle');
      expect(translate(locale, 'routing.reviewHint', { count: 3 })).toContain('3');
      expect(translate(locale, 'routing.reviewHint', { count: 3 })).not.toContain('{');
    }
  });
});

it('reads provider and credential metadata while keeping existing fields', async () => {
  const api = {
    get: async <T,>(path: string) => (path === '/credentials' ? { files: [{ name: 'oauth.json', provider: 'codex', prefix: 'oauth' }] }
      : path === '/config/routing' ? {}
      : path === '/config/api-keys/codex' ? [{ name: 'Codex', prefix: 'group', keys: [{ 'api-key': 'fixture-c', prefix: '' }] }]
      : path === '/config/api-keys/openai-compatibility' ? [{ name: 'Provider', prefix: 'group', keys: [{ 'api-key': 'fixture-a' }, { 'api-key': 'fixture-b' }] }] : []) as T,
    put: async () => ({}), patch: async () => ({}),
  };
  const board = await readRoutingBoard(api);
  expect(board.partial).toEqual([]);
  expect(board.members.find(item => item.family === 'openai-compatibility')).toMatchObject({ keyCount: 2, prefix: 'group', weights: [null, null] });
  expect(board.members.find(item => item.family === 'codex')).toMatchObject({ prefix: '' });
  expect(board.members.find(item => item.kind === 'credential')).toMatchObject({ keyCount: 1, prefix: 'oauth', credentialName: 'oauth.json' });
});

it('resolves provider remarks and displays them on routing cards', async () => {
  const api = {
    get: async <T,>(path: string) => (path === '/credentials' ? { files: [] }
      : path === '/config/routing' ? {}
      : path === '/config/api-keys/codex' ? [{ name: 'codex-4', prefix: 'group', keys: [{ 'api-key': 'sk-test' }] }]
      : []) as T,
    put: async () => ({}), patch: async () => ({}),
  };
  const board = await readRoutingBoard(api, async queries => {
    expect(queries[0].providerSection).toBe('codex-api-key');
    expect(queries[0].providerName).toBe('codex-4');
    return ['清汤面', ''];
  });
  const member = board.members.find(item => item.name === 'codex-4');
  expect(member?.remark).toBe('清汤面');

  const rendered = ladder(board);
  expect(rendered).toContain('清汤面');
  expect(rendered).toContain('codex-4');
});
