import {
  type Branch,
  type Commit,
  type CommitStatus,
  type CreatePullRequestInput,
  invalid,
  type Pipeline,
  type PullRequest,
  type RemoteAdapter,
  RemoteError,
  type RemoteRepository,
  type RemoteRequestOptions,
  type TreeEntry,
} from '@remote/core';

export {
  BitbucketDataCenterBridgeAdapter,
  type BitbucketDataCenterBridgeOptions,
  BitbucketDataCenterBridgeServer,
  connectBitbucketDataCenterBridge,
  createBridgeLaunch,
  createBridgeLaunchFromQuery,
  relayBitbucketDataCenterBridge,
} from './bridge.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 100;

export type BitbucketDataCenterAdapterOptions = {
  apiBaseUrl: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
};

type RepositoryLocator = { project: string; repository: string };

export class BitbucketDataCenterAdapter implements RemoteAdapter {
  readonly id = 'bitbucket-datacenter';
  readonly capabilities = {
    writeFiles: false,
    manageBranches: false,
    createPullRequests: false,
    statuses: false,
    pipelines: false,
  } as const;

  private readonly apiBaseUrl: URL;
  private readonly branchUtilsBaseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: BitbucketDataCenterAdapterOptions) {
    this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
    this.branchUtilsBaseUrl = branchUtilsBaseUrl(this.apiBaseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listRepositories(options?: RemoteRequestOptions): Promise<RemoteRepository[]> {
    const values = await this.paginate('repos', options);
    return values.map((value) => toRepository(record(value))).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getRepository(repositoryId: string, options?: RemoteRequestOptions): Promise<RemoteRepository> {
    const locator = decodeRepositoryId(repositoryId);
    const path = repositoryPath(locator);
    const [repository, defaultBranch] = await Promise.all([
      this.getJson(path, options),
      this.getJson(`${path}/branches/default`, options),
    ]);
    return toRepository(
      record(repository),
      requiredString(record(defaultBranch), 'displayId', 'default branch'),
    );
  }

  async resolveRef(repositoryId: string, ref: string, options?: RemoteRequestOptions): Promise<string> {
    const locator = decodeRepositoryId(repositoryId);
    const branches = await this.paginate(
      `${repositoryPath(locator)}/branches?filterText=${encodeURIComponent(ref)}`,
      options,
    );
    const exact = branches.map(record).find((branch) => optionalString(branch, 'displayId') === ref);
    if (exact) return requiredString(exact, 'latestCommit', 'branch');

    const commit = record(
      await this.getJson(`${repositoryPath(locator)}/commits/${encodeURIComponent(ref)}`, options),
    );
    return requiredString(commit, 'id', 'commit');
  }

  async listDirectory(
    repositoryId: string,
    commitId: string,
    path: string,
    options?: RemoteRequestOptions,
  ): Promise<TreeEntry[]> {
    const locator = decodeRepositoryId(repositoryId);
    const suffix = encodePath(path);
    const endpoint = `${repositoryPath(locator)}/browse${suffix ? `/${suffix}` : ''}?at=${encodeURIComponent(commitId)}`;
    const values = await this.paginateChildren(endpoint, options);
    return values.map((value) => {
      const child = record(value);
      const childPath = record(child.path);
      const fullPath = requiredString(childPath, 'toString', 'tree entry');
      const type = requiredString(child, 'type', 'tree entry').toUpperCase();
      if (type !== 'FILE' && type !== 'DIRECTORY') {
        throw invalid(`Unsupported Bitbucket tree entry type: ${type}`);
      }
      return {
        name: optionalString(childPath, 'name') ?? fullPath.split('/').at(-1) ?? fullPath,
        path: fullPath,
        type: type === 'FILE' ? 'file' : 'directory',
        size: type === 'FILE' ? (optionalNumber(child, 'size') ?? 0) : 0,
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
    const response = await this.request(
      `${repositoryPath(locator)}/raw/${encodePath(path)}?at=${encodeURIComponent(commitId)}`,
      options,
      'application/octet-stream, */*',
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async commit(): Promise<Commit> {
    throw unsupported('File commits');
  }

  async listBranches(repositoryId: string, options?: RemoteRequestOptions): Promise<Branch[]> {
    const locator = decodeRepositoryId(repositoryId);
    return (await this.paginate(`${repositoryPath(locator)}/branches`, options))
      .map((value) => {
        const branch = record(value);
        return {
          name: requiredString(branch, 'displayId', 'branch'),
          head: requiredString(branch, 'latestCommit', 'branch'),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createBranch(
    repositoryId: string,
    name: string,
    fromCommit: string,
    options?: RemoteRequestOptions,
  ): Promise<Branch> {
    const locator = decodeRepositoryId(repositoryId);
    const branch = record(
      await this.getJson(
        `${repositoryPath(locator)}/branches`,
        options,
        {
          method: 'POST',
          body: JSON.stringify({ name, startPoint: fromCommit }),
        },
        this.branchUtilsBaseUrl,
      ),
    );
    return {
      name: requiredString(branch, 'displayId', 'branch'),
      head: requiredString(branch, 'latestCommit', 'branch'),
    };
  }

  async deleteBranch(repositoryId: string, name: string, options?: RemoteRequestOptions): Promise<void> {
    const locator = decodeRepositoryId(repositoryId);
    await this.request(
      `${repositoryPath(locator)}/branches?name=${encodeURIComponent(name)}`,
      options,
      'application/json',
      {
        method: 'DELETE',
      },
      this.branchUtilsBaseUrl,
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
    const values = await this.paginate(
      `${repositoryPath(locator)}/commits?until=${encodeURIComponent(ref)}`,
      options,
      safeLimit,
    );
    return values.map((value) => toCommit(record(value)));
  }

  async listPullRequests(repositoryId: string, options?: RemoteRequestOptions): Promise<PullRequest[]> {
    const locator = decodeRepositoryId(repositoryId);
    return (await this.paginate(`${repositoryPath(locator)}/pull-requests?state=OPEN`, options)).map(
      (value) => toPullRequest(record(value)),
    );
  }

  async createPullRequest(
    repositoryId: string,
    input: CreatePullRequestInput,
    options?: RemoteRequestOptions,
  ): Promise<PullRequest> {
    const locator = decodeRepositoryId(repositoryId);
    return toPullRequest(
      record(
        await this.getJson(`${repositoryPath(locator)}/pull-requests`, options, {
          method: 'POST',
          body: JSON.stringify({
            title: input.title,
            description: input.description,
            fromRef: pullRequestRef(input.sourceBranch, locator),
            toRef: pullRequestRef(input.targetBranch, locator),
          }),
        }),
      ),
    );
  }

  async listCommitStatuses(): Promise<CommitStatus[]> {
    return [];
  }

  async listPipelines(): Promise<Pipeline[]> {
    return [];
  }

  private async paginate(
    firstPath: string,
    options?: RemoteRequestOptions,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<unknown[]> {
    const values: unknown[] = [];
    let start = 0;
    while (values.length < limit) {
      const separator = firstPath.includes('?') ? '&' : '?';
      const page = record(
        await this.getJson(`${firstPath}${separator}limit=${PAGE_LIMIT}&start=${start}`, options),
      );
      const pageValues = page.values;
      if (!Array.isArray(pageValues)) throw invalid('Bitbucket returned an invalid paginated response.');
      values.push(...pageValues.slice(0, limit - values.length));
      if (page.isLastPage === true || pageValues.length === 0 || values.length >= limit) break;
      const next = optionalNumber(page, 'nextPageStart');
      if (next === undefined || next <= start) throw invalid('Bitbucket returned invalid pagination state.');
      start = next;
    }
    return values;
  }

  private async paginateChildren(firstPath: string, options?: RemoteRequestOptions): Promise<unknown[]> {
    const values: unknown[] = [];
    let start = 0;
    while (true) {
      const separator = firstPath.includes('?') ? '&' : '?';
      const browse = record(
        await this.getJson(`${firstPath}${separator}limit=${PAGE_LIMIT}&start=${start}`, options),
      );
      const children = record(browse.children);
      const pageValues = children.values;
      if (!Array.isArray(pageValues)) throw invalid('Bitbucket returned invalid directory children.');
      values.push(...pageValues);
      if (children.isLastPage === true || pageValues.length === 0) return values;
      const next = optionalNumber(children, 'nextPageStart');
      if (next === undefined || next <= start) throw invalid('Bitbucket returned invalid pagination state.');
      start = next;
    }
  }

  private async getJson(
    path: string,
    options?: RemoteRequestOptions,
    init?: RequestInit,
    baseUrl = this.apiBaseUrl,
  ): Promise<unknown> {
    const response = await this.request(path, options, 'application/json', init, baseUrl);
    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType.includes('text/html')) {
      throw new RemoteError('authentication', 'Bitbucket returned a login page. Sign in and try again.');
    }
    try {
      return await response.json();
    } catch {
      throw invalid('Bitbucket returned invalid JSON.');
    }
  }

  private async request(
    path: string,
    options?: RemoteRequestOptions,
    accept = 'application/json',
    init?: RequestInit,
    baseUrl = this.apiBaseUrl,
  ): Promise<Response> {
    const url = new URL(path.replace(/^\//u, ''), baseUrl);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
      throw invalid('Refusing to request an URL outside the configured Bitbucket API.');
    }
    const linked = linkedAbort(options?.signal, this.requestTimeoutMs);
    try {
      const response = await this.fetcher(url, {
        credentials: 'same-origin',
        headers: {
          Accept: accept,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
        redirect: 'manual',
        signal: linked.signal,
        ...init,
      });
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw new RemoteError('authentication', 'Bitbucket redirected the request. Sign in and try again.');
      }
      if (response.url) {
        const finalUrl = new URL(response.url);
        if (finalUrl.origin !== baseUrl.origin || !finalUrl.pathname.startsWith(baseUrl.pathname)) {
          throw new RemoteError('authentication', 'Bitbucket redirected the request outside its REST API.');
        }
      }
      if (response.ok) return response;
      throw await responseError(response);
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      if (options?.signal?.aborted) throw new RemoteError('cancelled', 'Bitbucket request was cancelled.');
      if (linked.signal.aborted) throw new RemoteError('unavailable', 'Bitbucket request timed out.');
      throw new RemoteError(
        'unavailable',
        error instanceof Error ? error.message : 'Bitbucket request failed.',
      );
    } finally {
      linked.dispose();
    }
  }
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
    const value = record(
      JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))),
    );
    return {
      project: requiredString(value, 'project', 'repository ID'),
      repository: requiredString(value, 'repository', 'repository ID'),
    };
  } catch {
    throw invalid('Invalid Bitbucket Data Center repository ID.');
  }
}

function normalizeApiBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw invalid('Bitbucket API URL must use HTTP.');
  url.pathname = `${url.pathname.replace(/\/*$/u, '')}/`;
  url.search = '';
  url.hash = '';
  return url;
}

function branchUtilsBaseUrl(apiBaseUrl: URL): URL {
  const url = new URL(apiBaseUrl);
  if (!url.pathname.endsWith('/api/1.0/')) throw invalid('Bitbucket API URL must end in /api/1.0/.');
  url.pathname = `${url.pathname.slice(0, -'/api/1.0/'.length)}/branch-utils/1.0/`;
  return url;
}

function repositoryPath(locator: RepositoryLocator): string {
  return `projects/${encodeURIComponent(locator.project)}/repos/${encodeURIComponent(locator.repository)}`;
}

function pullRequestRef(branch: string, locator: RepositoryLocator) {
  return {
    id: `refs/heads/${branch}`,
    repository: { slug: locator.repository, project: { key: locator.project } },
  };
}

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function toRepository(value: Record<string, unknown>, resolvedDefaultBranch?: string): RemoteRepository {
  const project = record(value.project);
  const defaultBranch = optionalRecord(value, 'defaultBranch');
  const slug = requiredString(value, 'slug', 'repository');
  return {
    id: encodeRepositoryId({ project: requiredString(project, 'key', 'project'), repository: slug }),
    name: optionalString(value, 'name') ?? slug,
    description: optionalString(value, 'description') ?? '',
    defaultBranch: resolvedDefaultBranch ?? optionalString(defaultBranch, 'displayId') ?? '',
  };
}

function toCommit(value: Record<string, unknown>): Commit {
  const author = optionalRecord(value, 'author');
  const timestamp = optionalNumber(value, 'authorTimestamp') ?? optionalNumber(value, 'committerTimestamp');
  return {
    id: requiredString(value, 'id', 'commit'),
    message: optionalString(value, 'message') ?? '',
    author: optionalString(author, 'displayName') ?? optionalString(author, 'name') ?? 'Unknown',
    date: timestamp === undefined ? new Date(0).toISOString() : new Date(timestamp).toISOString(),
  };
}

function toPullRequest(value: Record<string, unknown>): PullRequest {
  const fromRef = record(value.fromRef);
  const toRef = record(value.toRef);
  const state = requiredString(value, 'state', 'pull request').toUpperCase();
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'DECLINED') {
    throw invalid(`Unsupported Bitbucket pull request state: ${state}`);
  }
  return {
    id: String(requiredNumber(value, 'id', 'pull request')),
    title: requiredString(value, 'title', 'pull request'),
    description: optionalString(value, 'description') ?? '',
    sourceBranch: requiredString(fromRef, 'displayId', 'pull request source branch'),
    targetBranch: requiredString(toRef, 'displayId', 'pull request target branch'),
    state: state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : 'declined',
  };
}

function unsupported(feature: string): RemoteError {
  return new RemoteError('unsupported', `${feature} is disabled in the read-only Data Center adapter.`);
}

async function responseError(response: Response): Promise<RemoteError> {
  let detail = '';
  try {
    const errors = record(await response.json()).errors;
    if (Array.isArray(errors) && errors.length > 0)
      detail = optionalString(record(errors[0]), 'message') ?? '';
  } catch {
    // Ignore malformed error bodies.
  }
  const suffix = detail ? ` ${detail}` : '';
  if (response.status === 401)
    return new RemoteError('authentication', `Bitbucket session expired.${suffix}`);
  if (response.status === 403) return new RemoteError('permission', `Bitbucket denied this action.${suffix}`);
  if (response.status === 404)
    return new RemoteError('not-found', `Bitbucket resource was not found.${suffix}`);
  if (response.status === 409) return new RemoteError('conflict', `Bitbucket reported a conflict.${suffix}`);
  if (response.status === 429) return new RemoteError('rate-limit', `Bitbucket rate limit reached.${suffix}`);
  return new RemoteError('unavailable', `Bitbucket request failed with HTTP ${response.status}.${suffix}`);
}

function linkedAbort(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = globalThis.setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid('Invalid Bitbucket response.');
  return value as Record<string, unknown>;
}

function optionalRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const candidate = value[key];
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function requiredString(value: Record<string, unknown>, key: string, label: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || !candidate) throw invalid(`Bitbucket returned an invalid ${label}.`);
  return candidate;
}

function optionalString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function requiredNumber(value: Record<string, unknown>, key: string, label: string): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw invalid(`Bitbucket returned an invalid ${label}.`);
  }
  return candidate;
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}
