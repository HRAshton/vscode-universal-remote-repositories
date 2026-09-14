import {
  type AdapterCapabilities,
  type Branch,
  type Commit,
  type CommitChange,
  type CommitStatus,
  type CreatePullRequestInput,
  invalid,
  type Pipeline,
  type PullRequest,
  type RemoteAdapter,
  RemoteError,
  type RemoteErrorCode,
  type RemoteRepository,
  type RemoteRequestOptions,
  type TreeEntry,
} from '@remote/core';

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 1024 * 1024;

export type BitbucketDataCenterBridgeLaunch = {
  bitbucketOrigin: string;
  capability: string;
};

type Operation =
  | 'listRepositories'
  | 'getRepository'
  | 'resolveRef'
  | 'listDirectory'
  | 'readFile'
  | 'commit'
  | 'listBranches'
  | 'createBranch'
  | 'deleteBranch'
  | 'listCommits'
  | 'listPullRequests'
  | 'createPullRequest'
  | 'listCommitStatuses'
  | 'listPipelines';

type RequestMessage = { type: 'request'; id: number; operation: Operation; arguments: unknown[] };
type CancelMessage = { type: 'cancel'; id: number };
type ResponseMessage =
  | { type: 'response'; id: number; result: unknown }
  | { type: 'error'; id: number; code: RemoteErrorCode; message: string };
type ReadyMessage = { type: 'ready'; version: typeof PROTOCOL_VERSION; capabilities: AdapterCapabilities };
type DisconnectMessage = { type: 'disconnect' };

export type BitbucketDataCenterBridgeOptions = { onDisconnect?: () => void };

const operations = new Set<Operation>([
  'listRepositories',
  'getRepository',
  'resolveRef',
  'listDirectory',
  'readFile',
  'commit',
  'listBranches',
  'createBranch',
  'deleteBranch',
  'listCommits',
  'listPullRequests',
  'createPullRequest',
  'listCommitStatuses',
  'listPipelines',
]);

export function createBridgeLaunch(url: URL): BitbucketDataCenterBridgeLaunch | undefined {
  const value = new URLSearchParams(url.hash.slice(1));
  const capability = value.get('remote-bb-dc-capability');
  const origin = value.get('remote-bb-dc-origin');
  if (!capability || !origin || capability.length < 32) return undefined;
  try {
    const bitbucketOrigin = new URL(origin).origin;
    return bitbucketOrigin === 'null' ? undefined : { bitbucketOrigin, capability };
  } catch {
    return undefined;
  }
}

/** A narrow RPC client; it deliberately has no raw HTTP request operation. */
export class BitbucketDataCenterBridgeAdapter implements RemoteAdapter {
  readonly id = 'bitbucket-datacenter';
  readonly capabilities: AdapterCapabilities;

  constructor(
    private readonly client: BridgeClient,
    capabilities: AdapterCapabilities,
  ) {
    this.capabilities = capabilities;
  }

  listRepositories(options?: RemoteRequestOptions): Promise<RemoteRepository[]> {
    return this.client.call('listRepositories', [], options);
  }
  getRepository(repositoryId: string, options?: RemoteRequestOptions): Promise<RemoteRepository> {
    return this.client.call('getRepository', [repositoryId], options);
  }
  resolveRef(repositoryId: string, ref: string, options?: RemoteRequestOptions): Promise<string> {
    return this.client.call('resolveRef', [repositoryId, ref], options);
  }
  listDirectory(
    repositoryId: string,
    commitId: string,
    path: string,
    options?: RemoteRequestOptions,
  ): Promise<TreeEntry[]> {
    return this.client.call('listDirectory', [repositoryId, commitId, path], options);
  }
  readFile(
    repositoryId: string,
    commitId: string,
    path: string,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array> {
    return this.client
      .call('readFile', [repositoryId, commitId, path], options)
      .then((value) => (value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer)));
  }
  commit(
    repositoryId: string,
    branch: string,
    message: string,
    expectedHead: string,
    changes: CommitChange[],
    options?: RemoteRequestOptions,
  ): Promise<Commit> {
    return this.client.call('commit', [repositoryId, branch, message, expectedHead, changes], options);
  }
  listBranches(repositoryId: string, options?: RemoteRequestOptions): Promise<Branch[]> {
    return this.client.call('listBranches', [repositoryId], options);
  }
  createBranch(
    repositoryId: string,
    name: string,
    fromCommit: string,
    options?: RemoteRequestOptions,
  ): Promise<Branch> {
    return this.client.call('createBranch', [repositoryId, name, fromCommit], options);
  }
  deleteBranch(repositoryId: string, name: string, options?: RemoteRequestOptions): Promise<void> {
    return this.client.call('deleteBranch', [repositoryId, name], options);
  }
  listCommits(
    repositoryId: string,
    ref: string,
    limit: number,
    options?: RemoteRequestOptions,
  ): Promise<Commit[]> {
    return this.client.call('listCommits', [repositoryId, ref, limit], options);
  }
  listPullRequests(repositoryId: string, options?: RemoteRequestOptions): Promise<PullRequest[]> {
    return this.client.call('listPullRequests', [repositoryId], options);
  }
  createPullRequest(
    repositoryId: string,
    input: CreatePullRequestInput,
    options?: RemoteRequestOptions,
  ): Promise<PullRequest> {
    return this.client.call('createPullRequest', [repositoryId, input], options);
  }
  listCommitStatuses(
    repositoryId: string,
    commitId: string,
    options?: RemoteRequestOptions,
  ): Promise<CommitStatus[]> {
    return this.client.call('listCommitStatuses', [repositoryId, commitId], options);
  }
  listPipelines(repositoryId: string, commitId: string, options?: RemoteRequestOptions): Promise<Pipeline[]> {
    return this.client.call('listPipelines', [repositoryId, commitId], options);
  }
}

export async function connectBitbucketDataCenterBridge(
  options: BitbucketDataCenterBridgeOptions = {},
): Promise<BitbucketDataCenterBridgeAdapter> {
  const launch = createBridgeLaunch(new URL(globalThis.location.href));
  if (!launch || !globalThis.window.opener)
    throw new RemoteError('unavailable', 'Open VS Code from a Bitbucket Data Center tab.');
  const channel = new MessageChannel();
  const client = new BridgeClient(channel.port1, options.onDisconnect);
  globalThis.window.opener.postMessage(
    { type: 'remote-bb-dc-connect', version: PROTOCOL_VERSION, capability: launch.capability },
    launch.bitbucketOrigin,
    [channel.port2],
  );
  return new BitbucketDataCenterBridgeAdapter(client, await client.waitForReady());
}

export class BitbucketDataCenterBridgeServer {
  private readonly requests = new Map<number, AbortController>();

  constructor(
    private readonly adapter: RemoteAdapter,
    private readonly capabilities: AdapterCapabilities,
  ) {}

  attach(port: MessagePort): void {
    port.onmessage = (event) => void this.handle(port, event.data);
    port.start();
    port.postMessage({
      type: 'ready',
      version: PROTOCOL_VERSION,
      capabilities: this.capabilities,
    } satisfies ReadyMessage);
  }

  private async handle(port: MessagePort, value: unknown): Promise<void> {
    if (isCancel(value)) {
      this.requests.get(value.id)?.abort();
      return;
    }
    if (!isRequest(value)) return;
    const controller = new AbortController();
    this.requests.set(value.id, controller);
    try {
      const result = await invoke(this.adapter, value.operation, value.arguments, {
        signal: controller.signal,
      });
      port.postMessage({ type: 'response', id: value.id, result } satisfies ResponseMessage);
    } catch (error) {
      const remote =
        error instanceof RemoteError
          ? error
          : new RemoteError(
              'unavailable',
              error instanceof Error ? error.message : 'Bitbucket bridge request failed.',
            );
      port.postMessage({
        type: 'error',
        id: value.id,
        code: remote.code,
        message: remote.message,
      } satisfies ResponseMessage);
    } finally {
      this.requests.delete(value.id);
    }
  }
}

class BridgeClient {
  private nextId = 1;
  private ready: Promise<AdapterCapabilities>;
  private resolveReady!: (value: AdapterCapabilities) => void;
  private rejectReady!: (error: Error) => void;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly port: MessagePort,
    private readonly onDisconnect: (() => void) | undefined,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    port.onmessage = (event) => this.handle(event.data);
    port.onmessageerror = () => this.disconnect();
    port.start();
    globalThis.setTimeout(
      () => this.rejectReady(new RemoteError('unavailable', 'Bitbucket bridge did not connect.')),
      10_000,
    );
  }

  waitForReady(): Promise<AdapterCapabilities> {
    return this.ready;
  }

  call<T>(operation: Operation, arguments_: unknown[], options?: RemoteRequestOptions): Promise<T> {
    if (options?.signal?.aborted)
      return Promise.reject(new RemoteError('cancelled', 'Bitbucket request was cancelled.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        this.port.postMessage({ type: 'cancel', id } satisfies CancelMessage);
        this.pending.delete(id);
        reject(new RemoteError('cancelled', 'Bitbucket request was cancelled.'));
      };
      options?.signal?.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          options?.signal?.removeEventListener('abort', cancel);
          resolve(value as T);
        },
        reject: (error) => {
          options?.signal?.removeEventListener('abort', cancel);
          reject(error);
        },
      });
      this.port.postMessage({
        type: 'request',
        id,
        operation,
        arguments: arguments_,
      } satisfies RequestMessage);
    });
  }

  private handle(value: unknown): void {
    if (isReady(value)) {
      this.resolveReady(value.capabilities);
      return;
    }
    if (isDisconnect(value)) {
      this.disconnect();
      return;
    }
    if (!isResponse(value)) return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.type === 'response') pending.resolve(value.result);
    else pending.reject(new RemoteError(value.code, value.message));
  }

  private disconnect(): void {
    const error = new RemoteError('unavailable', 'Bitbucket bridge disconnected.');
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onDisconnect?.();
  }
}

function invoke(
  adapter: RemoteAdapter,
  operation: Operation,
  args: unknown[],
  options: RemoteRequestOptions,
): Promise<unknown> {
  switch (operation) {
    case 'listRepositories':
      return adapter.listRepositories(options);
    case 'getRepository':
      return adapter.getRepository(stringArg(args, 0), options);
    case 'resolveRef':
      return adapter.resolveRef(stringArg(args, 0), stringArg(args, 1), options);
    case 'listDirectory':
      return adapter.listDirectory(stringArg(args, 0), stringArg(args, 1), stringArg(args, 2), options);
    case 'readFile':
      return adapter.readFile(stringArg(args, 0), stringArg(args, 1), stringArg(args, 2), options);
    case 'commit':
      return adapter.commit(
        stringArg(args, 0),
        stringArg(args, 1),
        stringArg(args, 2),
        stringArg(args, 3),
        arrayArg(args, 4) as CommitChange[],
        options,
      );
    case 'listBranches':
      return adapter.listBranches(stringArg(args, 0), options);
    case 'createBranch':
      return adapter.createBranch(stringArg(args, 0), stringArg(args, 1), stringArg(args, 2), options);
    case 'deleteBranch':
      return adapter.deleteBranch(stringArg(args, 0), stringArg(args, 1), options);
    case 'listCommits':
      return adapter.listCommits(stringArg(args, 0), stringArg(args, 1), numberArg(args, 2), options);
    case 'listPullRequests':
      return adapter.listPullRequests(stringArg(args, 0), options);
    case 'createPullRequest':
      return adapter.createPullRequest(
        stringArg(args, 0),
        objectArg(args, 1) as CreatePullRequestInput,
        options,
      );
    case 'listCommitStatuses':
      return adapter.listCommitStatuses(stringArg(args, 0), stringArg(args, 1), options);
    case 'listPipelines':
      return adapter.listPipelines(stringArg(args, 0), stringArg(args, 1), options);
  }
}

function isRequest(value: unknown): value is RequestMessage {
  return (
    isRecord(value) &&
    value.type === 'request' &&
    Number.isSafeInteger(value.id) &&
    typeof value.operation === 'string' &&
    operations.has(value.operation as Operation) &&
    Array.isArray(value.arguments) &&
    serializedSize(value.arguments) <= MAX_REQUEST_BYTES
  );
}

function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
function isCancel(value: unknown): value is CancelMessage {
  return isRecord(value) && value.type === 'cancel' && Number.isSafeInteger(value.id);
}
function isReady(value: unknown): value is ReadyMessage {
  return (
    isRecord(value) &&
    value.type === 'ready' &&
    value.version === PROTOCOL_VERSION &&
    isRecord(value.capabilities)
  );
}
function isResponse(value: unknown): value is ResponseMessage {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.id) &&
    (value.type === 'response' ||
      (value.type === 'error' && typeof value.code === 'string' && typeof value.message === 'string'))
  );
}

function isDisconnect(value: unknown): value is DisconnectMessage {
  return isRecord(value) && value.type === 'disconnect';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function stringArg(args: unknown[], index: number): string {
  const value = args[index];
  if (typeof value !== 'string' || value.length > 16_384) throw invalid('Invalid Bitbucket bridge request.');
  return value;
}
function numberArg(args: unknown[], index: number): number {
  const value = args[index];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalid('Invalid Bitbucket bridge request.');
  return value;
}
function arrayArg(args: unknown[], index: number): unknown[] {
  const value = args[index];
  if (!Array.isArray(value)) throw invalid('Invalid Bitbucket bridge request.');
  return value;
}
function objectArg(args: unknown[], index: number): Record<string, unknown> {
  const value = args[index];
  if (!isRecord(value)) throw invalid('Invalid Bitbucket bridge request.');
  return value;
}
