import type { RemoteAdapter } from '@remote/core';
import * as vscode from 'vscode';
import type { BitbucketCredentialStore } from './auth.js';
import { registerCommands } from './commands.js';
import { SnapshotContentProvider } from './content-provider.js';
import { RepositoryController } from './controller.js';
import { RemoteFileSystemProvider } from './file-system.js';
import { ScmController } from './scm.js';
import { MementoOverlayStorage } from './storage.js';
import { RemoteTreeProvider } from './views.js';

export async function activateRemoteRepositories(
  context: vscode.ExtensionContext,
  adapters: RemoteAdapter[],
  credentials?: BitbucketCredentialStore,
): Promise<void> {
  const storage = new MementoOverlayStorage(context.globalState);
  const controller = new RepositoryController(adapters, storage);
  const fileSystem = new RemoteFileSystemProvider(controller);

  context.subscriptions.push(
    controller,
    fileSystem,
    vscode.workspace.registerFileSystemProvider('remote', fileSystem, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      'remote-base',
      new SnapshotContentProvider(controller, 'base'),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      'remote-working',
      new SnapshotContentProvider(controller, 'working'),
    ),
  );

  await controller.start();
  const scm = new ScmController(controller);
  const pullRequests = new RemoteTreeProvider('pullRequests', controller);
  const statuses = new RemoteTreeProvider('statuses', controller);
  const pipelines = new RemoteTreeProvider('pipelines', controller);
  context.subscriptions.push(
    scm,
    pullRequests,
    statuses,
    pipelines,
    vscode.window.registerTreeDataProvider('remote.pullRequests', pullRequests),
    vscode.window.registerTreeDataProvider('remote.statuses', statuses),
    vscode.window.registerTreeDataProvider('remote.pipelines', pipelines),
  );
  registerCommands(context, controller, scm, credentials);
  console.log('Universal Remote Repositories activated.');
}
