import { oauthSubpages, type OAuthSubpage } from './oauthNavigation';

/** Event emitted by the Rust side when another launch asked for a page (`--page`). */
export const LAUNCH_PAGE_EVENT = 'navigate-page';

export type LaunchTarget<PageId extends string> = {
  page: PageId;
  oauthSubpage?: OAuthSubpage;
};

/**
 * Parse a `--page` value into a page (and optional OAuth subpage).
 * Accepts `home`, `oauth`, `oauth/quota`, and the bare subpage aliases `quota`,
 * `authFiles`, `login`, which live inside the OAuth page.
 */
export function parseLaunchTarget<PageId extends string>(
  value: string | null | undefined,
  pageIds: readonly PageId[],
): LaunchTarget<PageId> | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const [head, tail, ...rest] = raw.split('/');
  if (rest.length > 0) return null;
  const subpageIds = oauthSubpages.map((subpage) => subpage.id);
  const isSubpage = (id: string): id is OAuthSubpage => (subpageIds as string[]).includes(id);
  const isPage = (id: string): id is PageId => (pageIds as readonly string[]).includes(id);

  if (tail === undefined) {
    if (isPage(head)) return { page: head };
    if (isSubpage(head) && isPage('oauth')) return { page: 'oauth' as PageId, oauthSubpage: head };
    return null;
  }
  if (head === 'oauth' && isPage(head) && isSubpage(tail)) {
    return { page: head, oauthSubpage: tail };
  }
  return null;
}
