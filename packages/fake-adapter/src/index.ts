import {
  invalid,
  normalizePath,
  notFound,
  RemoteConflictError,
  type Branch,
  type Commit,
  type CommitChange,
  type CommitStatus,
  type CreatePullRequestInput,
  type Pipeline,
  type PullRequest,
  type RemoteAdapter,
  type RemoteRepository,
  type TreeEntry,
} from '@remote/core';

type StoredCommit = {
  value: Commit;
  parent: string | null;
  files: Map<string, Uint8Array>;
};

type FakeRepository = {
  metadata: RemoteRepository;
  branches: Map<string, string>;
  commits: Map<string, StoredCommit>;
  pullRequests: PullRequest[];
  statuses: Map<string, CommitStatus[]>;
  pipelines: Map<string, Pipeline[]>;
};

const encoder = new TextEncoder();

export class FakeRemoteAdapter implements RemoteAdapter {
  readonly id = 'fake';
  readonly capabilities = {
    writeFiles: true,
    manageBranches: true,
    createPullRequests: true,
    statuses: true,
    pipelines: true,
  } as const;
  private readonly repositories = new Map<string, FakeRepository>();
  private commitSequence = 2;
  private pullRequestSequence = 1;

  constructor() {
    this.seedDemoRepository();
  }

  async listRepositories(): Promise<RemoteRepository[]> {
    return [...this.repositories.values()]
      .map((repository) => ({ ...repository.metadata }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getRepository(repositoryId: string): Promise<RemoteRepository> {
    return { ...this.requireRepository(repositoryId).metadata };
  }

  async resolveRef(repositoryId: string, ref: string): Promise<string> {
    const repository = this.requireRepository(repositoryId);
    const branchHead = repository.branches.get(ref);
    if (branchHead) {
      return branchHead;
    }
    if (repository.commits.has(ref)) {
      return ref;
    }
    throw notFound(`Ref ${ref}`);
  }

  async listDirectory(repositoryId: string, commitId: string, path: string): Promise<TreeEntry[]> {
    const files = this.requireCommit(repositoryId, commitId).files;
    const normalized = normalizePath(path);
    if (normalized && files.has(normalized)) {
      throw invalid(`${normalized} is not a directory.`);
    }
    const prefix = normalized ? `${normalized}/` : '';
    if (normalized && ![...files.keys()].some((file) => file.startsWith(prefix))) {
      throw notFound(normalized);
    }

    const entries = new Map<string, TreeEntry>();
    for (const [filePath, content] of files) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      const remainder = filePath.slice(prefix.length);
      const separator = remainder.indexOf('/');
      const name = separator < 0 ? remainder : remainder.slice(0, separator);
      if (!name) {
        continue;
      }
      const entryPath = normalized ? `${normalized}/${name}` : name;
      const type = separator < 0 ? 'file' : 'directory';
      entries.set(name, {
        name,
        path: entryPath,
        type,
        size: type === 'file' ? content.byteLength : 0,
      });
    }
    return [...entries.values()].sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  async readFile(repositoryId: string, commitId: string, path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const content = this.requireCommit(repositoryId, commitId).files.get(normalized);
    if (!content) {
      throw notFound(normalized);
    }
    return content.slice();
  }

  async commit(
    repositoryId: string,
    branch: string,
    message: string,
    expectedHead: string,
    changes: CommitChange[],
  ): Promise<Commit> {
    const repository = this.requireRepository(repositoryId);
    const actualHead = repository.branches.get(branch);
    if (!actualHead) {
      throw notFound(`Branch ${branch}`);
    }
    if (actualHead !== expectedHead) {
      throw new RemoteConflictError(
        `Branch ${branch} moved from ${expectedHead} to ${actualHead}.`,
        expectedHead,
        actualHead,
      );
    }
    if (!message.trim()) {
      throw invalid('Commit message is required.');
    }
    if (changes.length === 0) {
      throw invalid('At least one file change is required.');
    }

    const files = cloneFiles(this.requireCommit(repositoryId, expectedHead).files);
    const seen = new Set<string>();
    for (const change of changes) {
      const path = normalizePath(change.path);
      if (!path) {
        throw invalid('Repository root cannot be committed as a file.');
      }
      if (seen.has(path)) {
        throw invalid(`Duplicate change for ${path}.`);
      }
      seen.add(path);
      if (change.content === null) {
        files.delete(path);
      } else {
        files.set(path, change.content.slice());
      }
    }
    for (const path of files.keys()) {
      if ([...files.keys()].some((candidate) => candidate.startsWith(`${path}/`))) {
        throw invalid(`${path} cannot be both a file and a directory.`);
      }
    }

    const stored = this.createCommit(repository, message.trim(), expectedHead, files);
    repository.branches.set(branch, stored.value.id);
    this.seedChecks(repository, stored.value.id);
    return { ...stored.value };
  }

  async listBranches(repositoryId: string): Promise<Branch[]> {
    return [...this.requireRepository(repositoryId).branches]
      .map(([name, head]) => ({ name, head }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createBranch(repositoryId: string, name: string, fromCommit: string): Promise<Branch> {
    const repository = this.requireRepository(repositoryId);
    const normalized = validateBranchName(name);
    this.requireCommit(repositoryId, fromCommit);
    if (repository.branches.has(normalized)) {
      throw invalid(`Branch ${normalized} already exists.`);
    }
    repository.branches.set(normalized, fromCommit);
    return { name: normalized, head: fromCommit };
  }

  async deleteBranch(repositoryId: string, name: string): Promise<void> {
    const repository = this.requireRepository(repositoryId);
    if (name === repository.metadata.defaultBranch) {
      throw invalid('Default branch cannot be deleted.');
    }
    if (!repository.branches.delete(name)) {
      throw notFound(`Branch ${name}`);
    }
  }

  async listCommits(repositoryId: string, ref: string, limit: number): Promise<Commit[]> {
    const repository = this.requireRepository(repositoryId);
    let current: string | null = await this.resolveRef(repositoryId, ref);
    const commits: Commit[] = [];
    const safeLimit = Math.max(0, Math.floor(limit));
    while (current && commits.length < safeLimit) {
      const stored = repository.commits.get(current);
      if (!stored) {
        break;
      }
      commits.push({ ...stored.value });
      current = stored.parent;
    }
    return commits;
  }

  async listPullRequests(repositoryId: string): Promise<PullRequest[]> {
    return this.requireRepository(repositoryId).pullRequests.map((pullRequest) => ({ ...pullRequest }));
  }

  async createPullRequest(repositoryId: string, input: CreatePullRequestInput): Promise<PullRequest> {
    const repository = this.requireRepository(repositoryId);
    if (!input.title.trim()) {
      throw invalid('Pull request title is required.');
    }
    if (!repository.branches.has(input.sourceBranch) || !repository.branches.has(input.targetBranch)) {
      throw notFound('Pull request branch');
    }
    if (input.sourceBranch === input.targetBranch) {
      throw invalid('Pull request branches must differ.');
    }
    const pullRequest: PullRequest = {
      id: `pr-${++this.pullRequestSequence}`,
      title: input.title.trim(),
      description: input.description.trim(),
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      state: 'open',
    };
    repository.pullRequests.unshift(pullRequest);
    return { ...pullRequest };
  }

  async listCommitStatuses(repositoryId: string, commitId: string): Promise<CommitStatus[]> {
    const repository = this.requireRepository(repositoryId);
    this.requireCommit(repositoryId, commitId);
    return (repository.statuses.get(commitId) ?? []).map((status) => ({ ...status }));
  }

  async listPipelines(repositoryId: string, commitId: string): Promise<Pipeline[]> {
    const repository = this.requireRepository(repositoryId);
    this.requireCommit(repositoryId, commitId);
    return (repository.pipelines.get(commitId) ?? []).map((pipeline) => ({ ...pipeline }));
  }

  async applyRemoteCommit(
    repositoryId: string,
    branch: string,
    message: string,
    changes: CommitChange[],
  ): Promise<Commit> {
    const head = await this.resolveRef(repositoryId, branch);
    return this.commit(repositoryId, branch, message, head, changes);
  }

  setChecks(repositoryId: string, commitId: string, statuses: CommitStatus[], pipelines: Pipeline[]): void {
    const repository = this.requireRepository(repositoryId);
    this.requireCommit(repositoryId, commitId);
    repository.statuses.set(
      commitId,
      statuses.map((status) => ({ ...status, commitId })),
    );
    repository.pipelines.set(
      commitId,
      pipelines.map((pipeline) => ({ ...pipeline, commitId })),
    );
  }

  private seedDemoRepository(): void {
    const first: StoredCommit = {
      value: {
        id: 'c0001',
        message: 'Initial commit',
        author: 'Demo User',
        date: '2026-01-01T00:00:00.000Z',
      },
      parent: null,
      files: new Map([
        ['README.md', encoder.encode('# Demo remote repository\n')],
        ['src/index.ts', encoder.encode("export const greeting = 'hello';\n")],
      ]),
    };
    const secondFiles = cloneFiles(first.files);
    secondFiles.set('docs/guide.md', encoder.encode('# Guide\n\nEdit files and commit from VS Code.\n'));
    const second: StoredCommit = {
      value: {
        id: 'c0002',
        message: 'Add remote editing guide',
        author: 'Demo User',
        date: '2026-01-02T00:00:00.000Z',
      },
      parent: first.value.id,
      files: secondFiles,
    };
    const repository: FakeRepository = {
      metadata: {
        id: 'demo',
        name: 'Demo Repository',
        description: 'Deterministic in-memory repository for local development.',
        defaultBranch: 'main',
      },
      branches: new Map([
        ['main', second.value.id],
        ['feature/example', first.value.id],
      ]),
      commits: new Map([
        [first.value.id, first],
        [second.value.id, second],
      ]),
      pullRequests: [
        {
          id: 'pr-1',
          title: 'Example change',
          description: 'Seed pull request.',
          sourceBranch: 'feature/example',
          targetBranch: 'main',
          state: 'open',
        },
      ],
      statuses: new Map(),
      pipelines: new Map(),
    };
    this.repositories.set(repository.metadata.id, repository);
    this.seedChecks(repository, second.value.id, 'success');
  }

  private createCommit(
    repository: FakeRepository,
    message: string,
    parent: string,
    files: Map<string, Uint8Array>,
  ): StoredCommit {
    this.commitSequence += 1;
    const id = `c${this.commitSequence.toString().padStart(4, '0')}`;
    const stored: StoredCommit = {
      value: {
        id,
        message,
        author: 'Demo User',
        date: new Date(Date.UTC(2026, 0, this.commitSequence)).toISOString(),
      },
      parent,
      files,
    };
    repository.commits.set(id, stored);
    return stored;
  }

  private seedChecks(
    repository: FakeRepository,
    commitId: string,
    state: 'pending' | 'success' = 'pending',
  ): void {
    repository.statuses.set(commitId, [
      { id: `status-${commitId}`, commitId, name: 'quality', state, description: 'Quality checks' },
    ]);
    repository.pipelines.set(commitId, [{ id: `pipeline-${commitId}`, commitId, name: 'build', state }]);
  }

  private requireRepository(repositoryId: string): FakeRepository {
    const repository = this.repositories.get(repositoryId);
    if (!repository) {
      throw notFound(`Repository ${repositoryId}`);
    }
    return repository;
  }

  private requireCommit(repositoryId: string, commitId: string): StoredCommit {
    const commit = this.requireRepository(repositoryId).commits.get(commitId);
    if (!commit) {
      throw notFound(`Commit ${commitId}`);
    }
    return commit;
  }
}

function cloneFiles(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].map(([path, content]) => [path, content.slice()]));
}

function validateBranchName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.includes('..') ||
    normalized.includes('//') ||
    normalized.includes('@{') ||
    normalized.endsWith('.lock') ||
    /[\s~^:?*[\]\\]/u.test(normalized)
  ) {
    throw invalid(`Invalid branch name: ${name}`);
  }
  return normalized;
}
