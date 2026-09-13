import { RemoteError } from '@remote/core';
import * as vscode from 'vscode';
import type { RepositoryController } from './controller.js';
import { parseRemoteUri } from './uri.js';

export class RemoteFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly controllerListener: vscode.Disposable;

  readonly onDidChangeFile = this.changeEmitter.event;

  constructor(private readonly controller: RepositoryController) {
    this.controllerListener = controller.onDidChange(() => {
      const events = (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'remote')
        .map((folder) => ({ type: vscode.FileChangeType.Changed, uri: folder.uri }));
      if (events.length > 0) {
        this.changeEmitter.fire(events);
      }
    });
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.call(uri, async () => {
      const descriptor = this.requireDescriptor(uri);
      const session = await this.controller.getOrOpen(uri);
      const stat = await session.stat(descriptor.path);
      return toFileStat(stat.type, stat.size, !session.adapter.capabilities.writeFiles);
    });
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.call(uri, async () => {
      const descriptor = this.requireDescriptor(uri);
      const entries = await (await this.controller.getOrOpen(uri)).listDirectory(descriptor.path);
      return entries.map((entry): [string, vscode.FileType] => [
        entry.name,
        entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
      ]);
    });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.call(uri, async () => {
      const descriptor = this.requireDescriptor(uri);
      await (await this.controller.getOrOpen(uri)).createDirectory(descriptor.path);
      this.changed(vscode.FileChangeType.Created, uri);
    });
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.call(uri, async () => {
      const descriptor = this.requireDescriptor(uri);
      return (await this.controller.getOrOpen(uri)).readFile(descriptor.path);
    });
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    await this.call(uri, async () => {
      const descriptor = this.requireDescriptor(uri);
      const session = await this.controller.getOrOpen(uri);
      let existed = true;
      try {
        await session.stat(descriptor.path);
      } catch {
        existed = false;
      }
      await session.writeFile(descriptor.path, content, options);
      this.changed(existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri);
    });
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.call(uri, async () => {
      const descriptor = this.requireDescriptor(uri);
      await (await this.controller.getOrOpen(uri)).delete(descriptor.path, options.recursive);
      this.changed(vscode.FileChangeType.Deleted, uri);
    });
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    await this.call(oldUri, async () => {
      const oldDescriptor = this.requireDescriptor(oldUri);
      const newDescriptor = this.requireDescriptor(newUri);
      if (
        oldDescriptor.adapterId !== newDescriptor.adapterId ||
        oldDescriptor.repositoryId !== newDescriptor.repositoryId ||
        oldDescriptor.ref !== newDescriptor.ref
      ) {
        throw vscode.FileSystemError.NoPermissions('Cannot rename across repositories or refs.');
      }
      await (await this.controller.getOrOpen(oldUri)).rename(
        oldDescriptor.path,
        newDescriptor.path,
        options.overwrite,
      );
      this.changeEmitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    });
  }

  dispose(): void {
    this.controllerListener.dispose();
    this.changeEmitter.dispose();
  }

  private requireDescriptor(uri: vscode.Uri) {
    const descriptor = parseRemoteUri(uri);
    if (!descriptor) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return descriptor;
  }

  private changed(type: vscode.FileChangeType, uri: vscode.Uri): void {
    this.changeEmitter.fire([{ type, uri }]);
  }

  private async call<T>(uri: vscode.Uri, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        throw error;
      }
      if (error instanceof RemoteError) {
        if (error.code === 'not-found') {
          throw vscode.FileSystemError.FileNotFound(uri);
        }
        if (error.code === 'conflict') {
          throw vscode.FileSystemError.NoPermissions(error.message);
        }
        throw vscode.FileSystemError.Unavailable(error.message);
      }
      throw error;
    }
  }
}

function toFileStat(type: 'file' | 'directory', size: number, readonly: boolean): vscode.FileStat {
  const now = Date.now();
  return {
    type: type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
    ctime: now,
    mtime: now,
    size,
    ...(readonly ? { permissions: vscode.FilePermission.Readonly } : {}),
  };
}
