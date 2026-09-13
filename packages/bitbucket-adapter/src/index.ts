import {
  invalid,
  RemoteError,
  type Branch,
  type CheckState,
  type Commit,
  type CommitStatus,
  type CreatePullRequestInput,
  type Pipeline,
  type PullRequest,
  type PullRequestState,
  type RemoteAdapter,
  type RemoteRepository,
  type RemoteRequestOptions,
  type TreeEntry,
} from '@remote/core';

const API_BASE = 'https://api.bitbucket.org/2.0/';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_READ_ATTEMPTS = 3;

export type BitbucketAdapterOptions = {
  getToken: () => Promise<string | undefined>;
  getEmail?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
};

export class BitbucketRemoteAdapter implements RemoteAdapter {
  readonly id = 'bitbucket';
  readonly capabilities = {
    writeFiles: false,
    manageBranches: true,
    createPullRequests: true,
    statuses: true,
    pipelines: true,
  } as const;

  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: BitbucketAdapterOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? wait;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listRepositories(options?: RemoteRequestOptions): Promise<RemoteRepository[]> {
    const workspaces = await this.paginate('/workspaces?pagelen=100', options);
    const repositories: RemoteRepository[] = [];
    for (const value of workspaces) {
      const workspace = requiredString(record(value), 'slug', 'workspace');
      const path = `/repositories/${encodeURIComponent(workspace)}?role=member&pagelen=100`;
      for (const repository of await this.paginate(path, options)) {
        repositories.push(toRepository(record(repository), workspace));
      }
    }
    return repositories.sort((left, right) => left.name.localeCompare(right.name));
  }

  async getRepository(repositoryId: string, options?: RemoteRequestOptions): Promise<RemoteRepository> {
    const locator = decodeRepositoryId(repositoryId);
    const value = await this.getJson(repositoryPath(locator), options);
    return toRepository(record(value), locator.workspace);
  }

  async resolveRef(repositoryId: string, ref: string, options?: RemoteRequestOptions): Promise<string> {
    const locator = decodeRepositoryId(repositoryId);
    const value = record(
      await this.getJson(`${repositoryPath(locator)}/commit/${encodeURIComponent(ref)}`, options),
    );
    return requiredString(value, 'hash', 'commit');
  }

  async listDirectory(
    repositoryId: string,
    commitId: string,
    path: string,
    options?: RemoteRequestOptions,
  ): Promise<TreeEntry[]> {
    const locator = decodeRepositoryId(repositoryId);
    const suffix = encodeRepositoryPath(path);
    const endpoint = `${repositoryPath(locator)}/src/${encodeURIComponent(commitId)}/${suffix}`;
    const values = await this.paginate(endpoint, options);
    return values.map((value) => {
      const entry = record(value);
      const entryPath = requiredString(entry, 'path', 'tree entry');
      const type = requiredString(entry, 'type', 'tree entry');
      if (type !== 'commit_file' && type !== 'commit_directory') {
        throw invalid(`Unsupported Bitbucket tree entry type: ${type}`);
      }
      return {
        name: entryPath.split('/').at(-1) ?? entryPath,
        path: entryPath,
        type: type === 'commit_file' ? 'file' : 'directory',
        size: type === 'commit_file' ? (optionalNumber(entry, 'size') ?? 0) : 0,
      };
    });
  }

  async readFile(
    repositoryId: string,
    commitId: string,
    path: string,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array> {
    const locator = decodeRepositoryId(repositoryId);
    const endpoint = `${repositoryPath(locator)}/src/${encodeURIComponent(commitId)}/${encodeRepositoryPath(path)}`;
    const response = await this.request(endpoint, { method: 'GET' }, options);
    return new Uint8Array(await response.arrayBuffer());
  }

  async commit(): Promise<Commit> {
    throw new RemoteError(
      'unsupported',
      'Bitbucket file commits are disabled until stale-parent rejection is proven atomic.',
    );
  }

  async listBranches(repositoryId: string, options?: RemoteRequestOptions): Promise<Branch[]> {
    const locator = decodeRepositoryId(repositoryId);
    const values = await this.paginate(`${repositoryPath(locator)}/refs/branches?pagelen=100`, options);
    return values
      .map((value) => toBranch(record(value)))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createBranch(
    repositoryId: string,
    name: string,
    fromCommit: string,
    options?: RemoteRequestOptions,
  ): Promise<Branch> {
    const locator = decodeRepositoryId(repositoryId);
    const value = await this.sendJson(
      `${repositoryPath(locator)}/refs/branches`,
      'POST',
      { name: name.trim(), target: { hash: fromCommit } },
      options,
    );
    return toBranch(record(value));
  }

  async deleteBranch(repositoryId: string, name: string, options?: RemoteRequestOptions): Promise<void> {
    const locator = decodeRepositoryId(repositoryId);
    await this.request(
      `${repositoryPath(locator)}/refs/branches/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
      options,
    );
  }

  async listCommits(
    repositoryId: string,
    ref: string,
    limit: number,
    options?: RemoteRequestOptions,
  ): Promise<Commit[]> {
    const locator = decodeRepositoryId(repositoryId);
    const safeLimit = Math.max(0, Math.floor(limit));
    const endpoint = `${repositoryPath(locator)}/commits/${encodeURIComponent(ref)}?pagelen=${Math.min(safeLimit || 1, 100)}`;
    const values = await this.paginate(endpoint, options, safeLimit);
    return values.map((value) => toCommit(record(value)));
  }

  async listPullRequests(repositoryId: string, options?: RemoteRequestOptions): Promise<PullRequest[]> {
    const locator = decodeRepositoryId(repositoryId);
    const values = await this.paginate(
      `${repositoryPath(locator)}/pullrequests?state=OPEN&pagelen=50`,
      options,
    );
    return values.map((value) => toPullRequest(record(value)));
  }

  async createPullRequest(
    repositoryId: string,
    input: CreatePullRequestInput,
    options?: RemoteRequestOptions,
  ): Promise<PullRequest> {
    const locator = decodeRepositoryId(repositoryId);
    const value = await this.sendJson(
      `${repositoryPath(locator)}/pullrequests`,
      'POST',
      {
        title: input.title.trim(),
        description: input.description.trim(),
        source: { branch: { name: input.sourceBranch } },
        destination: { branch: { name: input.targetBranch } },
      },
      options,
    );
    return toPullRequest(record(value));
  }

  async listCommitStatuses(
    repositoryId: string,
    commitId: string,
    options?: RemoteRequestOptions,
  ): Promise<CommitStatus[]> {
    const locator = decodeRepositoryId(repositoryId);
    const values = await this.paginate(
      `${repositoryPath(locator)}/commit/${encodeURIComponent(commitId)}/statuses?pagelen=100`,
      options,
    );
    return values.map((value) => {
      const status = record(value);
      return {
        id: optionalString(status, 'uuid') ?? requiredString(status, 'key', 'commit status'),
        commitId,
        name: optionalString(status, 'name') ?? requiredString(status, 'key', 'commit status'),
        state: toCheckState(requiredString(status, 'state', 'commit status')),
        description: optionalString(status, 'description') ?? '',
      };
    });
  }

  async listPipelines(
    repositoryId: string,
    commitId: string,
    options?: RemoteRequestOptions,
  ): Promise<Pipeline[]> {
    const locator = decodeRepositoryId(repositoryId);
    const query = new URLSearchParams({
      pagelen: '50',
      q: `target.commit.hash="${commitId}"`,
    });
    const values = await this.paginate(`${repositoryPath(locator)}/pipelines/?${query}`, options);
    return values.map((value) => {
      const pipeline = record(value);
      const state = record(pipeline.state);
      const result = optionalRecord(state, 'result');
      const buildNumber = optionalNumber(pipeline, 'build_number');
      return {
        id: requiredString(pipeline, 'uuid', 'pipeline'),
        commitId,
        name: buildNumber === undefined ? 'Pipeline' : `Pipeline #${buildNumber}`,
        state: toCheckState(
          optionalString(result, 'name') ?? requiredString(state, 'name', 'pipeline state'),
        ),
      };
    });
  }

  private async paginate(
    firstPath: string,
    options?: RemoteRequestOptions,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<unknown[]> {
    const values: unknown[] = [];
    let next: string | undefined = firstPath;
    while (next && values.length < limit) {
      const page = record(await this.getJson(next, options));
      const pageValues = page.values;
      if (!Array.isArray(pageValues)) {
        throw invalid('Bitbucket returned an invalid paginated response.');
      }
      values.push(...pageValues.slice(0, limit - values.length));
      next = optionalString(page, 'next');
    }
    return values;
  }

  private async getJson(path: string, options?: RemoteRequestOptions): Promise<unknown> {
    const response = await this.request(path, { method: 'GET' }, options);
    return response.json();
  }

  private async sendJson(
    path: string,
    method: 'POST',
    body: unknown,
    options?: RemoteRequestOptions,
  ): Promise<unknown> {
    const response = await this.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      options,
    );
    return response.json();
  }

  private async request(path: string, init: RequestInit, options?: RemoteRequestOptions): Promise<Response> {
    const url = apiUrl(path);
    const method = init.method ?? 'GET';
    const attempts = method === 'GET' ? MAX_READ_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const token = (await this.options.getToken())?.trim();
      if (!token) {
        throw new RemoteError('authentication', 'Set a Bitbucket API token before accessing repositories.');
      }
      const email = (await this.options.getEmail?.())?.trim();
      const linked = linkedAbort(options?.signal, this.requestTimeoutMs);
      try {
        const headers = new Headers(init.headers);
        headers.set('Accept', 'application/json');
        headers.set('Authorization', email ? basicAuthorization(email, token) : `Bearer ${token}`);
        const response = await this.fetcher(url, { ...init, headers, signal: linked.signal });
        if (response.ok) {
          return response;
        }
        if (attempt < attempts && (response.status === 429 || response.status >= 500)) {
          await this.sleep(retryDelay(response, attempt), options?.signal);
          continue;
        }
        throw await responseError(response);
      } catch (error) {
        if (error instanceof RemoteError) {
          throw error;
        }
        if (options?.signal?.aborted) {
          throw new RemoteError('cancelled', 'Bitbucket request was cancelled.');
        }
        if (linked.signal.aborted) {
          throw new RemoteError('unavailable', 'Bitbucket request timed out.');
        }
        if (attempt === attempts) {
          throw new RemoteError(
            'unavailable',
            error instanceof Error ? error.message : 'Bitbucket request failed.',
          );
        }
        await this.sleep(250 * 2 ** (attempt - 1), options?.signal);
      } finally {
        linked.dispose();
      }
    }
    throw new RemoteError('unavailable', 'Bitbucket request failed.');
  }
}

type RepositoryLocator = { workspace: string; repository: string };

function basicAuthorization(email: string, token: string): string {
  const bytes = new TextEncoder().encode(`${email}:${token}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export function encodeRepositoryId(locator: RepositoryLocator): string {
  const bytes = new TextEncoder().encode(JSON.stringify(locator));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeRepositoryId(repositoryId: string): RepositoryLocator {
  try {
    const padded = repositoryId
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(repositoryId.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = record(JSON.parse(new TextDecoder().decode(bytes)));
    return {
      workspace: requiredString(value, 'workspace', 'repository ID'),
      repository: requiredString(value, 'repository', 'repository ID'),
    };
  } catch {
    throw invalid('Invalid Bitbucket repository ID.');
  }
}

function repositoryPath(locator: RepositoryLocator): string {
  return `/repositories/${encodeURIComponent(locator.workspace)}/${encodeURIComponent(locator.repository)}`;
}

function encodeRepositoryPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function toRepository(value: Record<string, unknown>, workspace: string): RemoteRepository {
  const mainBranch = optionalRecord(value, 'mainbranch');
  const repository = requiredString(value, 'slug', 'repository');
  return {
    id: encodeRepositoryId({ workspace, repository }),
    name: optionalString(value, 'name') ?? repository,
    description: optionalString(value, 'description') ?? '',
    defaultBranch: optionalString(mainBranch, 'name') ?? '',
  };
}

function toBranch(value: Record<string, unknown>): Branch {
  const target = record(value.target);
  return {
    name: requiredString(value, 'name', 'branch'),
    head: requiredString(target, 'hash', 'branch target'),
  };
}

function toCommit(value: Record<string, unknown>): Commit {
  const author = optionalRecord(value, 'author');
  return {
    id: requiredString(value, 'hash', 'commit'),
    message: optionalString(value, 'message') ?? '',
    author: optionalString(author, 'raw') ?? optionalString(author, 'display_name') ?? 'Unknown',
    date: requiredString(value, 'date', 'commit'),
  };
}

function toPullRequest(value: Record<string, unknown>): PullRequest {
  const source = record(value.source);
  const destination = record(value.destination);
  return {
    id: String(requiredNumber(value, 'id', 'pull request')),
    title: requiredString(value, 'title', 'pull request'),
    description: optionalString(value, 'description') ?? '',
    sourceBranch: requiredString(record(source.branch), 'name', 'pull request source branch'),
    targetBranch: requiredString(record(destination.branch), 'name', 'pull request destination branch'),
    state: toPullRequestState(requiredString(value, 'state', 'pull request')),
  };
}

function toPullRequestState(value: string): PullRequestState {
  switch (value.toUpperCase()) {
    case 'OPEN':
      return 'open';
    case 'MERGED':
      return 'merged';
    case 'DECLINED':
    case 'SUPERSEDED':
      return 'declined';
    default:
      throw invalid(`Unsupported Bitbucket pull request state: ${value}`);
  }
}

function toCheckState(value: string): CheckState {
  switch (value.toUpperCase()) {
    case 'SUCCESSFUL':
    case 'SUCCESS':
    case 'COMPLETED':
      return 'success';
    case 'FAILED':
    case 'FAILURE':
    case 'ERROR':
    case 'STOPPED':
      return 'failure';
    case 'INPROGRESS':
    case 'IN_PROGRESS':
    case 'RUNNING':
      return 'running';
    default:
      return 'pending';
  }
}

function apiUrl(path: string): string {
  const url = new URL(path.replace(/^\//u, ''), API_BASE);
  if (url.origin !== new URL(API_BASE).origin) {
    throw invalid('Bitbucket pagination returned an untrusted URL.');
  }
  return url.toString();
}

async function responseError(response: Response): Promise<RemoteError> {
  let detail = '';
  try {
    const body = record(await response.json());
    detail = optionalString(optionalRecord(body, 'error'), 'message') ?? '';
  } catch {
    // Ignore malformed error bodies.
  }
  const suffix = detail ? ` ${detail}` : '';
  switch (response.status) {
    case 401:
      return new RemoteError('authentication', `Bitbucket rejected the API token.${suffix}`);
    case 403:
      return new RemoteError(
        'permission',
        `Bitbucket denied this action. Check token scopes and branch restrictions.${suffix}`,
      );
    case 404:
      return new RemoteError('not-found', `Bitbucket resource was not found.${suffix}`);
    case 409:
      return new RemoteError('conflict', `Bitbucket reported a conflict.${suffix}`);
    case 429:
      return new RemoteError('rate-limit', `Bitbucket API rate limit reached.${suffix}`);
    default:
      return new RemoteError(
        'unavailable',
        `Bitbucket request failed with HTTP ${response.status}.${suffix}`,
      );
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After');
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 250 * 2 ** (attempt - 1);
}

function linkedAbort(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  const timeout = globalThis.setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      globalThis.clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RemoteError('cancelled', 'Bitbucket request was cancelled.'));
      return;
    }
    const timeout = globalThis.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timeout);
        reject(new RemoteError('cancelled', 'Bitbucket request was cancelled.'));
      },
      { once: true },
    );
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Bitbucket returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

function optionalRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value?.[key];
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function optionalString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function requiredString(value: Record<string, unknown>, key: string, subject: string): string {
  const candidate = optionalString(value, key);
  if (!candidate) throw invalid(`Bitbucket returned an invalid ${subject}.`);
  return candidate;
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function requiredNumber(value: Record<string, unknown>, key: string, subject: string): number {
  const candidate = optionalNumber(value, key);
  if (candidate === undefined) throw invalid(`Bitbucket returned an invalid ${subject}.`);
  return candidate;
}
