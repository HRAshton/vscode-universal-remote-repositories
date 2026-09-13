import { RemoteError } from '@remote/core';
import type * as vscode from 'vscode';
import type { RepositoryController } from './controller.js';
import { parseRemoteUri } from './uri.js';

export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly controller: RepositoryController,
    private readonly mode: 'base' | 'working',
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const remoteUri = uri.with({ scheme: 'remote' });
    const descriptor = parseRemoteUri(remoteUri);
    if (!descriptor) {
      return '';
    }
    const session = await this.controller.getOrOpen(remoteUri);
    try {
      const content =
        this.mode === 'base'
          ? await session.readBaseFile(descriptor.path)
          : await session.readFile(descriptor.path);
      return new TextDecoder().decode(content);
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'not-found') {
        return '';
      }
      throw error;
    }
  }
}
