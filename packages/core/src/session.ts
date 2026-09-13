import { decodeBase64, encodeBase64, equalBytes } from './encoding.js';
import { invalid, notFound, RemoteConflictError, RemoteError } from './errors.js';
import { baseName, isSameOrChild, normalizePath, parentPath } from './path.js';
import type {
  Commit,
  CommitChange,
  FileStat,
  OverlayEntry,
  OverlaySnapshot,
  OverlayStorage,
  RefreshResult,
  RemoteAdapter,
  RemoteRequestOptions,
  RepositoryIdentity,
  TreeEntry,
  WorkingTreeChange,
} from './types.js';

type WriteOptions = { create: boolean; overwrite: boolean };

export class RepositorySession {
  private snapshot: OverlaySnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly conflicts = new Set<string>();
  private mutation: Promise<void> = Promise.resolve();

  private constructor(
    readonly adapter: RemoteAdapter,
    readonly repositoryId: string,
    readonly ref: string,
    private readonly storage: OverlayStorage,
    snapshot: OverlaySnapshot,
  ) {
    this.snapshot = snapshot;
  }

  static async open(
    adapter: RemoteAdapter,
    repositoryId: string,
    ref: string,
    storage: OverlayStorage,
  ): Promise<RepositorySession> {
    if (!adapter.id || !repositoryId || !ref) {
      throw invalid('Adapter, repository, and ref are required.');
    }

    await adapter.getRepository(repositoryId);
    const remoteHead = await adapter.resolveRef(repositoryId, ref);
    const stored = await storage.get({ adapterId: adapter.id, repositoryId }, ref);
    const head = stored?.baseCommit ?? remoteHead;
    const snapshot = stored ?? RepositorySession.emptySnapshot(head);
    return new RepositorySession(adapter, repositoryId, ref, storage, snapshot);
  }

  get identity(): RepositoryIdentity {
    return { adapterId: this.adapter.id, repositoryId: this.repositoryId };
  }

  get baseCommit(): string {
    return this.snapshot.baseCommit;
  }

  get conflictPaths(): string[] {
    return [...this.conflicts].sort();
  }

  get hasChanges(): boolean {
    return (
      Object.keys(this.snapshot.entries).length > 0 ||
      this.snapshot.deletedPaths.length > 0 ||
      this.snapshot.renames.length > 0
    );
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stat(path: string): Promise<FileStat> {
    const normalized = normalizePath(path);
    const entry = this.snapshot.entries[normalized];
    if (entry && !this.isDeleted(normalized)) {
      return this.overlayStat(entry);
    }
    if (this.isDeleted(normalized)) {
      throw notFound(normalized || 'Path');
    }
    return this.statAt(this.snapshot.baseCommit, normalized);
  }

  async listDirectory(path: string): Promise<TreeEntry[]> {
    const normalized = normalizePath(path);
    const stat = await this.stat(normalized);
    if (stat.type !== 'directory') {
      throw invalid(`${normalized} is not a directory.`);
    }

    const entries = new Map<string, TreeEntry>();
    const baseStat = await this.tryStatAt(this.snapshot.baseCommit, normalized);
    if (baseStat?.type === 'directory') {
      for (const entry of await this.adapter.listDirectory(
        this.repositoryId,
        this.snapshot.baseCommit,
        normalized,
      )) {
        if (!this.isDeleted(entry.path)) {
          entries.set(entry.name, entry);
        }
      }
    }

    const prefix = normalized ? `${normalized}/` : '';
    for (const [entryPath, overlay] of Object.entries(this.snapshot.entries)) {
      if (this.isDeleted(entryPath) || !entryPath.startsWith(prefix)) {
        continue;
      }
      const remainder = entryPath.slice(prefix.length);
      if (!remainder || remainder.includes('/')) {
        continue;
      }
      entries.set(remainder, {
        name: remainder,
        path: entryPath,
        type: overlay.type,
        size: overlay.type === 'file' ? decodeBase64(overlay.contentBase64).byteLength : 0,
      });
    }

    return [...entries.values()].sort(compareTreeEntries);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const entry = this.snapshot.entries[normalized];
    if (entry && !this.isDeleted(normalized)) {
      if (entry.type !== 'file') {
        throw invalid(`${normalized} is not a file.`);
      }
      return decodeBase64(entry.contentBase64);
    }
    if (this.isDeleted(normalized)) {
      throw notFound(normalized);
    }
    return this.adapter.readFile(this.repositoryId, this.snapshot.baseCommit, normalized);
  }

  async readBaseFile(path: string): Promise<Uint8Array> {
    return this.adapter.readFile(this.repositoryId, this.snapshot.baseCommit, normalizePath(path));
  }

  async writeFile(path: string, content: Uint8Array, options: WriteOptions): Promise<void> {
    this.requireWritable();
    return this.withMutation(async () => {
      const normalized = this.requireNonRoot(path);
      const current = await this.tryStat(normalized);
      if (!current && !options.create) {
        throw notFound(normalized);
      }
      if (current && !options.overwrite) {
        throw new RemoteError('validation', `${normalized} already exists.`);
      }
      if (current?.type === 'directory') {
        throw invalid(`${normalized} is a directory.`);
      }
      await this.requireDirectory(parentPath(normalized) ?? '');

      const base = await this.tryReadAt(this.snapshot.baseCommit, normalized);
      if (base && equalBytes(base, content) && !this.isDeleted(normalized)) {
        delete this.snapshot.entries[normalized];
      } else {
        this.snapshot.entries[normalized] = {
          type: 'file',
          contentBase64: encodeBase64(content),
        };
      }
      this.undelete(normalized);
      await this.persistAndEmit();
    });
  }

  async createDirectory(path: string): Promise<void> {
    this.requireWritable();
    return this.withMutation(async () => {
      const normalized = this.requireNonRoot(path);
      if (await this.tryStat(normalized)) {
        throw new RemoteError('validation', `${normalized} already exists.`);
      }
      await this.requireDirectory(parentPath(normalized) ?? '');
      this.snapshot.entries[normalized] = { type: 'directory', contentBase64: '' };
      this.undelete(normalized);
      await this.persistAndEmit();
    });
  }

  async delete(path: string, recursive: boolean): Promise<void> {
    this.requireWritable();
    return this.withMutation(async () => {
      await this.deleteInternal(this.requireNonRoot(path), recursive);
      await this.persistAndEmit();
    });
  }

  async rename(source: string, target: string, overwrite: boolean): Promise<void> {
    this.requireWritable();
    return this.withMutation(async () => {
      const from = this.requireNonRoot(source);
      const to = this.requireNonRoot(target);
      if (from === to) {
        return;
      }
      if (isSameOrChild(to, from)) {
        throw invalid('Cannot move a directory inside itself.');
      }

      const sourceStat = await this.stat(from);
      const targetStat = await this.tryStat(to);
      if (targetStat && !overwrite) {
        throw new RemoteError('validation', `${to} already exists.`);
      }
      await this.requireDirectory(parentPath(to) ?? '');
      const materialized = await this.materialize(from, sourceStat);
      if (targetStat) {
        await this.deleteInternal(to, true);
      }
      await this.deleteInternal(from, true);

      for (const [oldPath, entry] of Object.entries(materialized)) {
        const suffix = oldPath.slice(from.length);
        const newPath = `${to}${suffix}`;
        this.snapshot.entries[newPath] = entry;
        this.undelete(newPath);
      }
      this.snapshot.renames = this.snapshot.renames.filter(
        (rename) => !isSameOrChild(rename.from, from) && !isSameOrChild(rename.to, to),
      );
      this.snapshot.renames.push({ from, to });
      await this.persistAndEmit();
    });
  }

  async getChanges(): Promise<WorkingTreeChange[]> {
    const changes: WorkingTreeChange[] = this.snapshot.renames.map(({ from, to }) => ({
      path: to,
      type: 'renamed',
      originalPath: from,
    }));

    for (const [path, entry] of Object.entries(this.snapshot.entries)) {
      if (entry.type !== 'file' || this.snapshot.renames.some((rename) => isSameOrChild(path, rename.to))) {
        continue;
      }
      const base = await this.tryReadAt(this.snapshot.baseCommit, path);
      if (!base) {
        changes.push({ path, type: 'added', originalPath: null });
      } else if (!equalBytes(base, decodeBase64(entry.contentBase64))) {
        changes.push({ path, type: 'modified', originalPath: null });
      }
    }

    for (const path of this.snapshot.deletedPaths) {
      if (this.snapshot.renames.some((rename) => isSameOrChild(path, rename.from))) {
        continue;
      }
      changes.push({ path, type: 'deleted', originalPath: null });
    }

    return changes.sort((left, right) => left.path.localeCompare(right.path));
  }

  async discard(path: string): Promise<void> {
    return this.withMutation(async () => {
      const normalized = normalizePath(path);
      const rename = this.snapshot.renames.find(
        (item) => isSameOrChild(normalized, item.from) || isSameOrChild(normalized, item.to),
      );
      if (rename) {
        this.removeOverlayTree(rename.to);
        this.snapshot.deletedPaths = this.snapshot.deletedPaths.filter(
          (deleted) => !isSameOrChild(deleted, rename.from),
        );
        this.snapshot.renames = this.snapshot.renames.filter((item) => item !== rename);
      } else {
        this.removeOverlayTree(normalized);
        this.snapshot.deletedPaths = this.snapshot.deletedPaths.filter(
          (deleted) => !isSameOrChild(deleted, normalized) && !isSameOrChild(normalized, deleted),
        );
      }
      this.removeConflicts(normalized);
      await this.persistAndEmit();
    });
  }

  async discardAll(): Promise<void> {
    return this.withMutation(async () => {
      this.snapshot = RepositorySession.emptySnapshot(this.snapshot.baseCommit);
      this.conflicts.clear();
      await this.persistAndEmit();
    });
  }

  async commit(message: string): Promise<Commit> {
    this.requireWritable();
    return this.withMutation(async () => {
      const trimmed = message.trim();
      if (!trimmed) {
        throw invalid('Commit message is required.');
      }
      if (!this.hasChanges) {
        throw invalid('No changes to commit.');
      }
      if (this.conflicts.size > 0) {
        throw new RemoteConflictError(
          'Resolve or discard conflicting changes before committing.',
          this.snapshot.baseCommit,
          await this.adapter.resolveRef(this.repositoryId, this.ref),
          this.conflictPaths,
        );
      }

      const changes = await this.buildCommitChanges();
      try {
        const commit = await this.adapter.commit(
          this.repositoryId,
          this.ref,
          trimmed,
          this.snapshot.baseCommit,
          changes,
        );
        this.snapshot = RepositorySession.emptySnapshot(commit.id);
        this.conflicts.clear();
        await this.persistAndEmit();
        return commit;
      } catch (error) {
        if (error instanceof RemoteConflictError) {
          const paths =
            error.conflictingPaths.length > 0 ? error.conflictingPaths : changes.map((change) => change.path);
          for (const path of paths) {
            this.conflicts.add(path);
          }
          this.emit();
        }
        throw error;
      }
    });
  }

  async refresh(options?: RemoteRequestOptions): Promise<RefreshResult> {
    return this.withMutation(async () => {
      const previousHead = this.snapshot.baseCommit;
      const remoteHead = await this.adapter.resolveRef(this.repositoryId, this.ref, options);
      if (remoteHead === previousHead) {
        return { previousHead, remoteHead, conflicts: this.conflictPaths };
      }

      if (!this.hasChanges) {
        this.snapshot = RepositorySession.emptySnapshot(remoteHead);
        this.conflicts.clear();
        await this.persistAndEmit();
        return { previousHead, remoteHead, conflicts: [] };
      }

      const affectedPaths = await this.refreshAffectedPaths(previousHead, remoteHead);
      const conflicts: string[] = [];
      for (const path of affectedPaths) {
        const before = await this.tryReadAt(previousHead, path);
        const after = await this.tryReadAt(remoteHead, path);
        if (!sameOptionalBytes(before, after)) {
          conflicts.push(path);
        }
      }

      this.conflicts.clear();
      for (const path of conflicts) {
        this.conflicts.add(path);
      }
      if (conflicts.length === 0) {
        this.snapshot.baseCommit = remoteHead;
        await this.persistAndEmit();
      } else {
        this.emit();
      }
      return { previousHead, remoteHead, conflicts: this.conflictPaths };
    });
  }

  private static emptySnapshot(baseCommit: string): OverlaySnapshot {
    return { version: 1, baseCommit, entries: {}, deletedPaths: [], renames: [] };
  }

  private async statAt(commitId: string, path: string): Promise<FileStat> {
    if (!path) {
      return { type: 'directory', size: 0 };
    }
    const parent = parentPath(path);
    if (parent === null) {
      throw notFound(path);
    }
    const entry = (await this.adapter.listDirectory(this.repositoryId, commitId, parent)).find(
      (candidate) => candidate.name === baseName(path),
    );
    if (!entry) {
      throw notFound(path);
    }
    return { type: entry.type, size: entry.size };
  }

  private async tryStatAt(commitId: string, path: string): Promise<FileStat | undefined> {
    try {
      return await this.statAt(commitId, path);
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'not-found') {
        return undefined;
      }
      throw error;
    }
  }

  private async tryStat(path: string): Promise<FileStat | undefined> {
    try {
      return await this.stat(path);
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'not-found') {
        return undefined;
      }
      throw error;
    }
  }

  private async tryReadAt(commitId: string, path: string): Promise<Uint8Array | undefined> {
    try {
      return await this.adapter.readFile(this.repositoryId, commitId, path);
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'not-found') {
        return undefined;
      }
      throw error;
    }
  }

  private async requireDirectory(path: string): Promise<void> {
    const stat = await this.stat(path);
    if (stat.type !== 'directory') {
      throw invalid(`${path} is not a directory.`);
    }
  }

  private async deleteInternal(path: string, recursive: boolean): Promise<void> {
    const stat = await this.stat(path);
    if (stat.type === 'directory' && !recursive && (await this.listDirectory(path)).length > 0) {
      throw invalid(`${path} is not empty.`);
    }
    const existedAtBase = Boolean(await this.tryStatAt(this.snapshot.baseCommit, path));
    this.removeOverlayTree(path);
    this.snapshot.deletedPaths = this.snapshot.deletedPaths.filter(
      (deleted) => !isSameOrChild(deleted, path),
    );
    if (existedAtBase && !this.snapshot.deletedPaths.some((deleted) => isSameOrChild(path, deleted))) {
      this.snapshot.deletedPaths.push(path);
    }
    this.snapshot.renames = this.snapshot.renames.filter((rename) => rename.to !== path);
  }

  private async materialize(path: string, stat: FileStat): Promise<Record<string, OverlayEntry>> {
    if (stat.type === 'file') {
      return { [path]: { type: 'file', contentBase64: encodeBase64(await this.readFile(path)) } };
    }
    const result: Record<string, OverlayEntry> = { [path]: { type: 'directory', contentBase64: '' } };
    for (const child of await this.listDirectory(path)) {
      Object.assign(result, await this.materialize(child.path, { type: child.type, size: child.size }));
    }
    return result;
  }

  private async buildCommitChanges(): Promise<CommitChange[]> {
    const changes = new Map<string, Uint8Array | null>();
    for (const [path, entry] of Object.entries(this.snapshot.entries)) {
      if (entry.type === 'file') {
        changes.set(path, decodeBase64(entry.contentBase64));
      }
    }
    for (const deleted of this.snapshot.deletedPaths) {
      const stat = await this.tryStatAt(this.snapshot.baseCommit, deleted);
      if (!stat) {
        continue;
      }
      if (stat.type === 'file') {
        changes.set(deleted, null);
      } else {
        for (const file of await this.listFilesAt(this.snapshot.baseCommit, deleted)) {
          changes.set(file, null);
        }
      }
    }
    return [...changes.entries()]
      .map(([path, content]) => ({ path, content }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private async refreshAffectedPaths(previousHead: string, remoteHead: string): Promise<string[]> {
    const affected = new Set(
      Object.entries(this.snapshot.entries)
        .filter(([, entry]) => entry.type === 'file')
        .map(([path]) => path),
    );
    const affectedRoots = [
      ...this.snapshot.deletedPaths,
      ...this.snapshot.renames.map((rename) => rename.to),
    ];
    for (const root of affectedRoots) {
      const before = await this.tryStatAt(previousHead, root);
      const after = await this.tryStatAt(remoteHead, root);
      if (before?.type === 'directory') {
        for (const file of await this.listFilesAt(previousHead, root)) {
          affected.add(file);
        }
      }
      if (after?.type === 'directory') {
        for (const file of await this.listFilesAt(remoteHead, root)) {
          affected.add(file);
        }
      }
      if (before?.type !== 'directory' || after?.type !== 'directory') {
        affected.add(root);
      }
    }
    return [...affected].sort();
  }

  private async listFilesAt(commitId: string, path: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await this.adapter.listDirectory(this.repositoryId, commitId, path)) {
      if (entry.type === 'file') {
        files.push(entry.path);
      } else {
        files.push(...(await this.listFilesAt(commitId, entry.path)));
      }
    }
    return files;
  }

  private isDeleted(path: string): boolean {
    return Boolean(path) && this.snapshot.deletedPaths.some((deleted) => isSameOrChild(path, deleted));
  }

  private undelete(path: string): void {
    this.snapshot.deletedPaths = this.snapshot.deletedPaths.filter(
      (deleted) => !isSameOrChild(deleted, path) && !isSameOrChild(path, deleted),
    );
  }

  private removeOverlayTree(path: string): void {
    for (const entryPath of Object.keys(this.snapshot.entries)) {
      if (isSameOrChild(entryPath, path)) {
        delete this.snapshot.entries[entryPath];
      }
    }
  }

  private removeConflicts(path: string): void {
    for (const conflict of this.conflicts) {
      if (isSameOrChild(conflict, path) || isSameOrChild(path, conflict)) {
        this.conflicts.delete(conflict);
      }
    }
  }

  private requireNonRoot(path: string): string {
    const normalized = normalizePath(path);
    if (!normalized) {
      throw invalid('Repository root cannot be changed.');
    }
    return normalized;
  }

  private requireWritable(): void {
    if (!this.adapter.capabilities.writeFiles) {
      throw new RemoteError(
        'unsupported',
        'This provider is read-only because atomic remote commit protection is unavailable.',
      );
    }
  }

  private overlayStat(entry: OverlayEntry): FileStat {
    return {
      type: entry.type,
      size: entry.type === 'file' ? decodeBase64(entry.contentBase64).byteLength : 0,
    };
  }

  private async persistAndEmit(): Promise<void> {
    if (this.hasChanges) {
      await this.storage.set(this.identity, this.ref, structuredClone(this.snapshot));
    } else {
      await this.storage.clear(this.identity, this.ref);
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async withMutation<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(action, action);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function compareTreeEntries(left: TreeEntry, right: TreeEntry): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function sameOptionalBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return equalBytes(left, right);
}
