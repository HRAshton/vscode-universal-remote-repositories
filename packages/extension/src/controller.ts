import {
  RemoteError,
  RepositorySession,
  type OverlayStorage,
  type RemoteAdapter,
  type RemoteRequestOptions,
} from '@remote/core';
import * as vscode from 'vscode';
import { parseRemoteUri, sessionKey, type RemoteUriDescriptor } from './uri.js';

const POLL_INTERVAL_MS = 30_000;

export class RepositoryController implements vscode.Disposable {
  private readonly sessions = new Map<string, RepositorySession>();
  private readonly sessionListeners = new Map<string, () => void>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pollHandle: number;
  private pollAbort: AbortController | undefined;

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    adapters: RemoteAdapter[],
    private readonly storage: OverlayStorage,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.disposables.push(
      this.changeEmitter,
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.syncWorkspace()),
      vscode.window.onDidChangeActiveTextEditor(() => this.changeEmitter.fire()),
    );
    this.pollHandle = globalThis.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private readonly adapters: Map<string, RemoteAdapter>;

  async start(): Promise<void> {
    await this.syncWorkspace();
  }

  getAdapter(adapterId: string): RemoteAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  getAdapters(): RemoteAdapter[] {
    return [...this.adapters.values()];
  }

  getAll(): RepositorySession[] {
    return [...this.sessions.values()];
  }

  getByKey(key: string): RepositorySession | undefined {
    return this.sessions.get(key);
  }

  getActive(): RepositorySession | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const descriptor = parseRemoteUri(editor.document.uri);
      if (descriptor) {
        return this.sessions.get(sessionKey(descriptor));
      }
    }
    return this.sessions.size === 1 ? this.sessions.values().next().value : undefined;
  }

  async getOrOpen(uri: vscode.Uri): Promise<RepositorySession> {
    const descriptor = parseRemoteUri(uri);
    if (!descriptor) {
      throw new Error(`Invalid remote repository URI: ${uri.toString()}`);
    }
    return this.openDescriptor(descriptor);
  }

  async refreshAll(showResult = false, options?: RemoteRequestOptions): Promise<void> {
    const results = await Promise.all(
      this.getAll().map(async (session) => ({ session, result: await session.refresh(options) })),
    );
    const conflicts = results.flatMap(({ session, result }) =>
      result.conflicts.map((path) => `${session.repositoryId}: ${path}`),
    );
    if (conflicts.length > 0) {
      void vscode.window.showWarningMessage(`Remote conflicts detected: ${conflicts.join(', ')}`);
    } else if (showResult) {
      void vscode.window.showInformationMessage('Remote repositories refreshed.');
    }
    this.changeEmitter.fire();
  }

  notifyChanged(): void {
    this.changeEmitter.fire();
  }

  async syncWorkspace(): Promise<void> {
    const descriptors = (vscode.workspace.workspaceFolders ?? [])
      .map((folder) => parseRemoteUri(folder.uri))
      .filter((descriptor): descriptor is RemoteUriDescriptor => Boolean(descriptor));
    const desired = new Set(descriptors.map((descriptor) => sessionKey(descriptor)));
    await Promise.all(descriptors.map((descriptor) => this.openDescriptor(descriptor)));

    for (const key of this.sessions.keys()) {
      if (!desired.has(key)) {
        this.sessionListeners.get(key)?.();
        this.sessionListeners.delete(key);
        this.sessions.delete(key);
      }
    }
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.pollAbort?.abort();
    globalThis.clearInterval(this.pollHandle);
    for (const disposeListener of this.sessionListeners.values()) {
      disposeListener();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async openDescriptor(descriptor: RemoteUriDescriptor): Promise<RepositorySession> {
    const key = sessionKey(descriptor);
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }
    const adapter = this.adapters.get(descriptor.adapterId);
    if (!adapter) {
      throw new Error(`Remote adapter ${descriptor.adapterId} is not registered.`);
    }
    const session = await RepositorySession.open(
      adapter,
      descriptor.repositoryId,
      descriptor.ref,
      this.storage,
    );
    this.sessions.set(key, session);
    this.sessionListeners.set(
      key,
      session.onDidChange(() => this.changeEmitter.fire()),
    );
    this.changeEmitter.fire();
    return session;
  }

  private async poll(): Promise<void> {
    if (this.sessions.size === 0) {
      return;
    }
    this.pollAbort?.abort();
    const abort = new AbortController();
    this.pollAbort = abort;
    try {
      await this.refreshAll(false, { signal: abort.signal });
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'cancelled') {
        return;
      }
      console.error('Remote repository refresh failed.', error);
    } finally {
      if (this.pollAbort === abort) {
        this.pollAbort = undefined;
      }
    }
  }
}
