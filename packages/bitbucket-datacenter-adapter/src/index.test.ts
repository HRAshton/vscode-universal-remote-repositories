import type { RemoteError } from '@remote/core';
import { describe, expect, it, vi } from 'vitest';
import { BitbucketDataCenterAdapter, decodeRepositoryId, encodeRepositoryId } from './index.js';

describe('BitbucketDataCenterAdapter', () => {
  it('uses the browser session and reads an immutable repository tree', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes('/branches?')) {
        return json({
          values: [{ displayId: 'main', latestCommit: 'abc123' }],
          isLastPage: true,
        });
      }
      if (url.includes('/browse')) {
        return json({
          children: {
            values: [{ path: { name: 'README.md', toString: 'README.md' }, type: 'FILE', size: 4 }],
            isLastPage: true,
          },
        });
      }
      if (url.includes('/raw/README.md')) return new Response('Demo');
      return json({ values: [], isLastPage: true });
    });
    const adapter = new BitbucketDataCenterAdapter({
      apiBaseUrl: 'https://stash.example.test/bitbucket/rest/api/1.0/',
      fetch: fetcher,
    });
    const repositoryId = encodeRepositoryId({ project: 'DEMO', repository: 'app' });

    const commit = await adapter.resolveRef(repositoryId, 'main');
    const entries = await adapter.listDirectory(repositoryId, commit, '');
    const contents = await adapter.readFile(repositoryId, commit, 'README.md');

    expect(commit).toBe('abc123');
    expect(entries).toEqual([{ name: 'README.md', path: 'README.md', type: 'file', size: 4 }]);
    expect(new TextDecoder().decode(contents)).toBe('Demo');
    expect(requests.every(({ init }) => init?.credentials === 'same-origin')).toBe(true);
    expect(requests.every(({ init }) => !new Headers(init?.headers).has('Authorization'))).toBe(true);
    expect(requests.map(({ url }) => url)).toContain(
      'https://stash.example.test/bitbucket/rest/api/1.0/projects/DEMO/repos/app/raw/README.md?at=abc123',
    );
  });

  it('paginates accessible repositories and preserves Data Center identity', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const start = new URL(String(input)).searchParams.get('start');
      return start === '0'
        ? json({
            values: [{ project: { key: 'A' }, slug: 'one', name: 'One' }],
            isLastPage: false,
            nextPageStart: 1,
          })
        : json({
            values: [{ project: { key: 'B' }, slug: 'two', name: 'Two' }],
            isLastPage: true,
          });
    });
    const adapter = new BitbucketDataCenterAdapter({
      apiBaseUrl: 'https://stash.example.test/rest/api/1.0/',
      fetch: fetcher,
    });

    const repositories = await adapter.listRepositories();

    expect(repositories.map(({ name }) => name)).toEqual(['One', 'Two']);
    expect(decodeRepositoryId(repositories[1]?.id ?? '')).toEqual({ project: 'B', repository: 'two' });
  });

  it('fails closed for writes and maps expired sessions', async () => {
    const adapter = new BitbucketDataCenterAdapter({
      apiBaseUrl: 'https://stash.example.test/rest/api/1.0/',
      fetch: vi.fn(async () => json({ errors: [{ message: 'login required' }] }, 401)),
    });
    const repositoryId = encodeRepositoryId({ project: 'DEMO', repository: 'app' });

    await expect(adapter.getRepository(repositoryId)).rejects.toMatchObject({
      code: 'authentication',
    });
    await expect(adapter.commit()).rejects.toEqual(
      expect.objectContaining<Partial<RemoteError>>({ code: 'unsupported' }),
    );
    expect(adapter.capabilities.writeFiles).toBe(false);
  });

  it('does not follow an authentication redirect into repository content', async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: '/login?next=/rest/api/1.0/' } }),
    );
    const adapter = new BitbucketDataCenterAdapter({
      apiBaseUrl: 'https://stash.example.test/rest/api/1.0/',
      fetch: fetcher,
    });
    const repositoryId = encodeRepositoryId({ project: 'DEMO', repository: 'app' });

    await expect(adapter.readFile(repositoryId, 'abc', 'README.md')).rejects.toMatchObject({
      code: 'authentication',
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'manual', credentials: 'same-origin' }),
    );
  });

  it('paginates directory children and rejects stalled pagination', async () => {
    const repositoryId = encodeRepositoryId({ project: 'DEMO', repository: 'app' });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const start = new URL(String(input)).searchParams.get('start');
      return start === '0'
        ? json({
            children: {
              values: [{ path: { name: 'a', toString: 'a' }, type: 'DIRECTORY' }],
              isLastPage: false,
              nextPageStart: 1,
            },
          })
        : json({
            children: {
              values: [{ path: { name: 'b', toString: 'b' }, type: 'DIRECTORY' }],
              isLastPage: true,
            },
          });
    });
    const adapter = new BitbucketDataCenterAdapter({
      apiBaseUrl: 'https://stash.example.test/rest/api/1.0/',
      fetch: fetcher,
    });

    await expect(adapter.listDirectory(repositoryId, 'abc', '')).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses branch-utils to create and delete branches', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ displayId: 'feature/demo', latestCommit: 'abc123' });
      return new Response(null, { status: 204 });
    });
    const adapter = new BitbucketDataCenterAdapter({
      apiBaseUrl: 'https://stash.example.test/bitbucket/rest/api/1.0/',
      fetch: fetcher,
    });
    const repositoryId = encodeRepositoryId({ project: 'DEMO', repository: 'app' });

    await expect(adapter.createBranch(repositoryId, 'feature/demo', 'abc123')).resolves.toEqual({
      name: 'feature/demo',
      head: 'abc123',
    });
    await adapter.deleteBranch(repositoryId, 'feature/demo');

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      new URL('https://stash.example.test/bitbucket/rest/branch-utils/1.0/projects/DEMO/repos/app/branches'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'feature/demo', startPoint: 'abc123' }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL(
        'https://stash.example.test/bitbucket/rest/branch-utils/1.0/projects/DEMO/repos/app/branches?name=feature%2Fdemo',
      ),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('qualifies pull request refs with their repository identity', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({
        id: 42,
        title: 'Demo',
        description: '',
        state: 'OPEN',
        fromRef: { displayId: 'feature/demo' },
        toRef: { displayId: 'main' },
      }),
    );
    const adapter = new BitbucketDataCenterAdapter({
      apiBaseUrl: 'https://stash.example.test/rest/api/1.0/',
      fetch: fetcher,
    });
    const repositoryId = encodeRepositoryId({ project: 'DEMO', repository: 'app' });

    await adapter.createPullRequest(repositoryId, {
      title: 'Demo',
      description: '',
      sourceBranch: 'feature/demo',
      targetBranch: 'main',
    });

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      fromRef: {
        id: 'refs/heads/feature/demo',
        repository: { slug: 'app', project: { key: 'DEMO' } },
      },
      toRef: {
        id: 'refs/heads/main',
        repository: { slug: 'app', project: { key: 'DEMO' } },
      },
    });
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
