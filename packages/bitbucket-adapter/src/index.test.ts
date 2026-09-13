import type { RemoteError } from '@remote/core';
import { describe, expect, it, vi } from 'vitest';
import { BitbucketRemoteAdapter, decodeRepositoryId } from './index.js';

describe('BitbucketRemoteAdapter', () => {
  it('discovers paginated private repositories and sends bearer authentication', async () => {
    const requests: Array<RequestInfo | URL> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(input);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret');
      const url = String(input);
      if (url.includes('/workspaces')) {
        return json({ values: [{ slug: 'team' }] });
      }
      if (url.includes('page=2')) {
        return json({
          values: [
            {
              slug: 'second',
              name: 'Second',
              description: '',
              mainbranch: { name: 'main' },
            },
          ],
        });
      }
      return json({
        values: [
          {
            slug: 'first',
            name: 'First',
            description: 'Private repository',
            mainbranch: { name: 'trunk' },
          },
        ],
        next: 'https://api.bitbucket.org/2.0/repositories/team?page=2',
      });
    });
    const adapter = new BitbucketRemoteAdapter({ getToken: async () => 'secret', fetch: fetcher });

    const repositories = await adapter.listRepositories();

    expect(repositories.map((repository) => repository.name)).toEqual(['First', 'Second']);
    expect(decodeRepositoryId(repositories[0]?.id ?? '')).toEqual({
      workspace: 'team',
      repository: 'first',
    });
    expect(requests).toHaveLength(3);
  });

  it('uses basic authentication when an email accompanies the token', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Basic YWxpY2VAZXhhbXBsZS5jb206c2VjcmV0');
      return json({ slug: 'repo', name: 'Repository', mainbranch: { name: 'main' } });
    });
    const adapter = new BitbucketRemoteAdapter({
      getToken: async () => 'secret',
      getEmail: async () => 'alice@example.com',
      fetch: fetcher,
    });

    await adapter.getRepository(repositoryId());

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not retry writes and maps permission failures', async () => {
    const fetcher = vi.fn(async () => json({ error: { message: 'scope missing' } }, 403));
    const adapter = new BitbucketRemoteAdapter({ getToken: async () => 'secret', fetch: fetcher });

    await expect(adapter.createBranch(repositoryId(), 'feature', 'abc')).rejects.toMatchObject({
      code: 'permission',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('retries rate-limited reads using Retry-After', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(json({ hash: 'abc' }));
    const sleep = vi.fn(async () => undefined);
    const adapter = new BitbucketRemoteAdapter({
      getToken: async () => 'secret',
      fetch: fetcher,
      sleep,
    });

    await expect(adapter.resolveRef(repositoryId(), 'main')).resolves.toBe('abc');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it('fails closed for file commits', async () => {
    const adapter = new BitbucketRemoteAdapter({
      getToken: async () => 'secret',
      fetch: vi.fn(),
    });

    await expect(adapter.commit()).rejects.toEqual(
      expect.objectContaining<Partial<RemoteError>>({ code: 'unsupported' }),
    );
    expect(adapter.capabilities.writeFiles).toBe(false);
  });

  it('rejects cross-origin pagination before sending the token', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/workspaces')) {
        return json({
          values: [{ slug: 'team' }],
          next: 'https://evil.example/steal',
        });
      }
      return json({ values: [] });
    });
    const adapter = new BitbucketRemoteAdapter({ getToken: async () => 'secret', fetch: fetcher });

    await expect(adapter.listRepositories()).rejects.toMatchObject({ code: 'validation' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('fails authentication before making a request when the token is absent', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = new BitbucketRemoteAdapter({ getToken: async () => undefined, fetch: fetcher });

    await expect(adapter.getRepository(repositoryId())).rejects.toMatchObject({ code: 'authentication' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps API authentication failures and preserves the provider detail', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: { message: 'expired token' } }, 401));
    const adapter = new BitbucketRemoteAdapter({ getToken: async () => 'secret', fetch: fetcher });

    await expect(adapter.getRepository(repositoryId())).rejects.toMatchObject({
      code: 'authentication',
      message: expect.stringContaining('expired token'),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects malformed paginated responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ values: 'not an array' }));
    const adapter = new BitbucketRemoteAdapter({ getToken: async () => 'secret', fetch: fetcher });

    await expect(adapter.listBranches(repositoryId())).rejects.toMatchObject({ code: 'validation' });
  });

  it('maps caller cancellation and does not retry it', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException('Aborted', 'AbortError');
    });
    const controller = new AbortController();
    const adapter = new BitbucketRemoteAdapter({ getToken: async () => 'secret', fetch: fetcher });
    const request = adapter.getRepository(repositoryId(), { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

function repositoryId(): string {
  return 'eyJ3b3Jrc3BhY2UiOiJ0ZWFtIiwicmVwb3NpdG9yeSI6InJlcG8ifQ';
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
