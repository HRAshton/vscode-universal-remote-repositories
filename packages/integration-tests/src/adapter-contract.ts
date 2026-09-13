import { RemoteConflictError, type RemoteAdapter } from '@remote/core';
import { describe, expect, it } from 'vitest';

export function describeAdapterContract(name: string, createAdapter: () => RemoteAdapter): void {
  describe(`${name} adapter contract`, () => {
    it('discovers repositories and reads immutable commit snapshots', async () => {
      const adapter = createAdapter();
      const [repository] = await adapter.listRepositories();
      expect(repository).toBeDefined();
      if (!repository) return;

      const head = await adapter.resolveRef(repository.id, repository.defaultBranch);
      const root = await adapter.listDirectory(repository.id, head, '');
      expect(root.map((entry) => entry.name)).toContain('README.md');
      expect(new TextDecoder().decode(await adapter.readFile(repository.id, head, 'README.md'))).toContain(
        'Demo',
      );
    });

    it('commits atomically with an expected-head guard', async () => {
      const adapter = createAdapter();
      const head = await adapter.resolveRef('demo', 'main');
      const commit = await adapter.commit('demo', 'main', 'Update README', head, [
        { path: 'README.md', content: new TextEncoder().encode('updated') },
      ]);
      expect(await adapter.resolveRef('demo', 'main')).toBe(commit.id);
      await expect(
        adapter.commit('demo', 'main', 'Stale update', head, [
          { path: 'README.md', content: new TextEncoder().encode('stale') },
        ]),
      ).rejects.toBeInstanceOf(RemoteConflictError);
    });

    it('supports branches, history, pull requests, statuses, and pipelines', async () => {
      const adapter = createAdapter();
      const head = await adapter.resolveRef('demo', 'main');
      await adapter.createBranch('demo', 'feature/contract', head);
      expect((await adapter.listBranches('demo')).map((branch) => branch.name)).toContain('feature/contract');
      expect(await adapter.listCommits('demo', 'main', 10)).not.toHaveLength(0);
      const pullRequest = await adapter.createPullRequest('demo', {
        title: 'Contract pull request',
        description: '',
        sourceBranch: 'feature/contract',
        targetBranch: 'main',
      });
      expect((await adapter.listPullRequests('demo')).map((item) => item.id)).toContain(pullRequest.id);
      expect(await adapter.listCommitStatuses('demo', head)).not.toHaveLength(0);
      expect(await adapter.listPipelines('demo', head)).not.toHaveLength(0);
      await adapter.deleteBranch('demo', 'feature/contract');
    });
  });
}
