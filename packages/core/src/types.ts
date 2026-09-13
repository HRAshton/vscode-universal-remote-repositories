export type RepositoryIdentity = {
  adapterId: string;
  repositoryId: string;
};

export type RemoteRepository = {
  id: string;
  name: string;
  description: string;
  defaultBranch: string;
};

export type TreeEntryType = 'file' | 'directory';

export type TreeEntry = {
  name: string;
  path: string;
  type: TreeEntryType;
  size: number;
};

export type FileStat = {
  type: TreeEntryType;
  size: number;
};

export type CommitChange = {
  path: string;
  content: Uint8Array | null;
};

export type Branch = {
  name: string;
  head: string;
};

export type Commit = {
  id: string;
  message: string;
  author: string;
  date: string;
};

export type PullRequestState = 'open' | 'merged' | 'declined';

export type PullRequest = {
  id: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  state: PullRequestState;
};

export type CreatePullRequestInput = {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
};

export type CheckState = 'pending' | 'running' | 'success' | 'failure';

export type CommitStatus = {
  id: string;
  commitId: string;
  name: string;
  state: CheckState;
  description: string;
};

export type Pipeline = {
  id: string;
  commitId: string;
  name: string;
  state: CheckState;
};

export type AdapterCapabilities = {
  readonly writeFiles: boolean;
  readonly manageBranches: boolean;
  readonly createPullRequests: boolean;
  readonly statuses: boolean;
  readonly pipelines: boolean;
};

export type RemoteRequestOptions = {
  signal?: AbortSignal;
};

export type RemoteAdapter = {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  listRepositories(options?: RemoteRequestOptions): Promise<RemoteRepository[]>;
  getRepository(repositoryId: string, options?: RemoteRequestOptions): Promise<RemoteRepository>;
  resolveRef(repositoryId: string, ref: string, options?: RemoteRequestOptions): Promise<string>;
  listDirectory(
    repositoryId: string,
    commitId: string,
    path: string,
    options?: RemoteRequestOptions,
  ): Promise<TreeEntry[]>;
  readFile(
    repositoryId: string,
    commitId: string,
    path: string,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array>;
  commit(
    repositoryId: string,
    branch: string,
    message: string,
    expectedHead: string,
    changes: CommitChange[],
    options?: RemoteRequestOptions,
  ): Promise<Commit>;
  listBranches(repositoryId: string, options?: RemoteRequestOptions): Promise<Branch[]>;
  createBranch(
    repositoryId: string,
    name: string,
    fromCommit: string,
    options?: RemoteRequestOptions,
  ): Promise<Branch>;
  deleteBranch(repositoryId: string, name: string, options?: RemoteRequestOptions): Promise<void>;
  listCommits(
    repositoryId: string,
    ref: string,
    limit: number,
    options?: RemoteRequestOptions,
  ): Promise<Commit[]>;
  listPullRequests(repositoryId: string, options?: RemoteRequestOptions): Promise<PullRequest[]>;
  createPullRequest(
    repositoryId: string,
    input: CreatePullRequestInput,
    options?: RemoteRequestOptions,
  ): Promise<PullRequest>;
  listCommitStatuses(
    repositoryId: string,
    commitId: string,
    options?: RemoteRequestOptions,
  ): Promise<CommitStatus[]>;
  listPipelines(repositoryId: string, commitId: string, options?: RemoteRequestOptions): Promise<Pipeline[]>;
};

export type OverlayEntry = {
  type: TreeEntryType;
  contentBase64: string;
};

export type RenameRecord = {
  from: string;
  to: string;
};

export type OverlaySnapshot = {
  version: 1;
  baseCommit: string;
  entries: Record<string, OverlayEntry>;
  deletedPaths: string[];
  renames: RenameRecord[];
};

export type OverlayStorage = {
  get(identity: RepositoryIdentity, ref: string): Promise<OverlaySnapshot | undefined>;
  set(identity: RepositoryIdentity, ref: string, snapshot: OverlaySnapshot): Promise<void>;
  clear(identity: RepositoryIdentity, ref: string): Promise<void>;
};

export type WorkingTreeChange = {
  path: string;
  type: 'added' | 'modified' | 'deleted' | 'renamed';
  originalPath: string | null;
};

export type RefreshResult = {
  previousHead: string;
  remoteHead: string;
  conflicts: string[];
};
