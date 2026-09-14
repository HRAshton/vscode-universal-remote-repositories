import { describe, expect, it, vi } from 'vitest';
import type { BitbucketPageContext } from './context.js';
import { createWorkbenchUrl, resolveLaunchRef } from './launch.js';

const context: BitbucketPageContext = {
  origin: 'https://stash.test',
  contextPath: '/bitbucket',
  project: 'APP',
  repository: 'web',
};

describe('Bitbucket Data Center launch', () => {
  it('resolves the default branch before constructing a folder URI', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/branches/default')) return json({ displayId: 'develop' });
      return json({ project: { key: 'APP' }, slug: 'web', name: 'Web' });
    });

    const ref = await resolveLaunchRef(context, fetcher);
    const url = createWorkbenchUrl(
      new URL('http://localhost:8080/'),
      context,
      ref,
      '12345678901234567890123456789012',
    );

    expect(ref).toBe('develop');
    expect(url.searchParams.get('folder')).toContain('?ref=develop');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses an explicit page ref without requesting the repository', async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(resolveLaunchRef({ ...context, ref: 'release/1.0' }, fetcher)).resolves.toBe('release/1.0');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
