import { type RemoteAdapter, RemoteError, type RemoteRepository, type RepositorySession } from '@remote/core';
import * as vscode from 'vscode';
import type { BitbucketCredentialStore } from './auth.js';
import type { RepositoryController } from './controller.js';
import type { ScmController } from './scm.js';
import { createRemoteUri, parseRemoteUri } from './uri.js';

type RepositoryPick = vscode.QuickPickItem & {
  adapter: RemoteAdapter;
  repository: RemoteRepository;
};

export function registerCommands(
  context: vscode.ExtensionContext,
  controller: RepositoryController,
  scm: ScmController,
  credentials?: BitbucketCredentialStore,
): void {
  const commands = [
    vscode.commands.registerCommand('remote.openRepository', () =>
      showErrors(() => openRepository(controller)),
    ),
    vscode.commands.registerCommand('remote.switchBranch', () => showErrors(() => switchBranch(controller))),
    vscode.commands.registerCommand('remote.createBranch', () => showErrors(() => createBranch(controller))),
    vscode.commands.registerCommand('remote.deleteBranch', () => showErrors(() => deleteBranch(controller))),
    vscode.commands.registerCommand('remote.viewHistory', () => showErrors(() => viewHistory(controller))),
    vscode.commands.registerCommand('remote.createPullRequest', () =>
      showErrors(() => createPullRequest(controller)),
    ),
    vscode.commands.registerCommand('remote.refresh', () => showErrors(() => controller.refreshAll(true))),
    vscode.commands.registerCommand('remote.commit', (key: string) =>
      showErrors(() => commit(controller, scm, key)),
    ),
    vscode.commands.registerCommand('remote.discard', (value?: unknown) =>
      showErrors(() => discard(controller, value)),
    ),
    vscode.commands.registerCommand('remote.discardAll', (value?: unknown) =>
      showErrors(() => discardAll(controller, value)),
    ),
    vscode.commands.registerCommand('remote.openChange', (value?: unknown) =>
      showErrors(() => openChange(value)),
    ),
  ];
  if (credentials) {
    commands.push(
      vscode.commands.registerCommand('remote.signInBitbucket', () =>
        showErrors(() => signInBitbucket(controller, credentials)),
      ),
      vscode.commands.registerCommand('remote.signOutBitbucket', () =>
        showErrors(() => signOutBitbucket(controller, credentials)),
      ),
    );
  }
  context.subscriptions.push(...commands);
}

async function openRepository(controller: RepositoryController): Promise<void> {
  const groups = await Promise.all(
    controller.getAdapters().map(async (adapter) =>
      (await adapter.listRepositories()).map(
        (repository): RepositoryPick => ({
          label: repository.name,
          description: `${adapter.id}: ${repository.id}`,
          detail: repository.description,
          adapter,
          repository,
        }),
      ),
    ),
  );
  const pick = await vscode.window.showQuickPick(groups.flat(), {
    placeHolder: 'Select a remote repository',
  });
  if (!pick) return;
  const repository = pick.repository.defaultBranch
    ? pick.repository
    : await pick.adapter.getRepository(pick.repository.id);
  const branches = await pick.adapter.listBranches(pick.repository.id);
  const branch = branches.find((candidate) => candidate.name === repository.defaultBranch) ?? branches.at(0);
  if (!branch) {
    throw new Error('Repository has no branches.');
  }
  await vscode.commands.executeCommand(
    'vscode.openFolder',
    createRemoteUri(pick.adapter.id, pick.repository.id, branch.name),
    { forceNewWindow: false },
  );
}

async function switchBranch(controller: RepositoryController): Promise<void> {
  const session = requireActive(controller);
  if (!session) return;
  const branches = await session.adapter.listBranches(session.repositoryId);
  const pick = await vscode.window.showQuickPick(
    branches.filter((branch) => branch.name !== session.ref).map((branch) => branch.name),
    { placeHolder: `Current branch: ${session.ref}` },
  );
  if (!pick) return;
  const folder = findWorkspaceFolder(session);
  if (!folder) {
    throw new Error('Remote repository workspace folder was not found.');
  }
  vscode.workspace.updateWorkspaceFolders(folder.index, 1, {
    uri: createRemoteUri(session.adapter.id, session.repositoryId, pick),
    name: `${session.repositoryId} (${pick})`,
  });
}

async function createBranch(controller: RepositoryController): Promise<void> {
  const session = requireActive(controller);
  if (!session) return;
  requireCapability(session.adapter.capabilities.manageBranches, 'Branch management');
  const name = await vscode.window.showInputBox({
    prompt: 'New branch name',
    validateInput: (value) => (value.trim() ? undefined : 'Branch name is required.'),
  });
  if (!name) return;
  await session.adapter.createBranch(session.repositoryId, name, session.baseCommit);
  controller.notifyChanged();
  void vscode.window.showInformationMessage(`Created branch ${name}.`);
}

async function deleteBranch(controller: RepositoryController): Promise<void> {
  const session = requireActive(controller);
  if (!session) return;
  requireCapability(session.adapter.capabilities.manageBranches, 'Branch management');
  const repository = await session.adapter.getRepository(session.repositoryId);
  const choices = (await session.adapter.listBranches(session.repositoryId))
    .filter((branch) => branch.name !== session.ref && branch.name !== repository.defaultBranch)
    .map((branch) => branch.name);
  const name = await vscode.window.showQuickPick(choices, { placeHolder: 'Select branch to delete' });
  if (!name) return;
  const confirmation = await vscode.window.showWarningMessage(
    `Delete branch ${name}?`,
    { modal: true },
    'Delete',
  );
  if (confirmation !== 'Delete') return;
  await session.adapter.deleteBranch(session.repositoryId, name);
  controller.notifyChanged();
  void vscode.window.showInformationMessage(`Deleted branch ${name}.`);
}

async function viewHistory(controller: RepositoryController): Promise<void> {
  const session = requireActive(controller);
  if (!session) return;
  const commits = await session.adapter.listCommits(session.repositoryId, session.ref, 50);
  await vscode.window.showQuickPick(
    commits.map((commit) => ({
      label: commit.message.split('\n')[0] || commit.id,
      description: commit.id,
      detail: `${commit.author} - ${new Date(commit.date).toLocaleString()}`,
    })),
    { placeHolder: `History for ${session.ref}` },
  );
}

async function createPullRequest(controller: RepositoryController): Promise<void> {
  const session = requireActive(controller);
  if (!session) return;
  requireCapability(session.adapter.capabilities.createPullRequests, 'Pull request creation');
  const targets = (await session.adapter.listBranches(session.repositoryId))
    .filter((branch) => branch.name !== session.ref)
    .map((branch) => branch.name);
  const targetBranch = await vscode.window.showQuickPick(targets, { placeHolder: 'Target branch' });
  if (!targetBranch) return;
  const title = await vscode.window.showInputBox({
    prompt: 'Pull request title',
    validateInput: (value) => (value.trim() ? undefined : 'Title is required.'),
  });
  if (!title) return;
  const description = (await vscode.window.showInputBox({ prompt: 'Description (optional)' })) ?? '';
  const pullRequest = await session.adapter.createPullRequest(session.repositoryId, {
    title,
    description,
    sourceBranch: session.ref,
    targetBranch,
  });
  controller.notifyChanged();
  void vscode.window.showInformationMessage(`Created pull request ${pullRequest.id}.`);
}

async function commit(controller: RepositoryController, scm: ScmController, key: string): Promise<void> {
  const session = controller.getByKey(key);
  const sourceControl = scm.getSourceControl(key);
  if (!session || !sourceControl) {
    throw new Error('Remote source control is unavailable.');
  }
  const message = sourceControl.inputBox.value.trim();
  if (!message) {
    void vscode.window.showWarningMessage('Commit message is required.');
    return;
  }
  await session.commit(message);
  sourceControl.inputBox.value = '';
  void vscode.window.showInformationMessage('Remote changes committed.');
}

async function discard(controller: RepositoryController, value: unknown): Promise<void> {
  const uri = resourceUri(value);
  if (!uri) {
    throw new Error('Select or open a remote change first.');
  }
  const descriptor = parseRemoteUri(uri);
  if (!descriptor) {
    throw new Error('Selected resource is not remote.');
  }
  const confirmation = await vscode.window.showWarningMessage(
    `Discard changes to ${descriptor.path}?`,
    { modal: true },
    'Discard',
  );
  if (confirmation === 'Discard') {
    const session = await controller.getOrOpen(uri);
    await session.discard(descriptor.path);
    await session.refresh();
  }
}

async function discardAll(controller: RepositoryController, value: unknown): Promise<void> {
  const uri = resourceUri(value);
  const session = uri ? await controller.getOrOpen(uri) : requireActive(controller);
  if (!session) return;
  const confirmation = await vscode.window.showWarningMessage(
    `Discard all changes in ${session.repositoryId}?`,
    { modal: true },
    'Discard All',
  );
  if (confirmation === 'Discard All') {
    await session.discardAll();
    await session.refresh();
  }
}

async function openChange(value: unknown): Promise<void> {
  const uri = resourceUri(value);
  if (!uri) {
    throw new Error('Select or open a remote change first.');
  }
  const descriptor = parseRemoteUri(uri);
  if (!descriptor) {
    throw new Error('Selected resource is not remote.');
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    uri.with({ scheme: 'remote-base' }),
    uri.with({ scheme: 'remote-working' }),
    `${descriptor.path} (Remote Change)`,
  );
}

async function signInBitbucket(
  controller: RepositoryController,
  credentials?: BitbucketCredentialStore,
): Promise<void> {
  if (!credentials) {
    throw new RemoteError('unsupported', 'Bitbucket authentication is unavailable in this build.');
  }
  const adapter = controller.getAdapter('bitbucket');
  if (!adapter) {
    throw new RemoteError('unsupported', 'Bitbucket adapter is unavailable.');
  }
  const email = await vscode.window.showInputBox({
    prompt: 'Bitbucket email (optional)',
    placeHolder: 'Leave blank to use Bearer token authentication',
    ignoreFocusOut: true,
  });
  if (email === undefined) return;
  const token = await vscode.window.showInputBox({
    prompt: 'Bitbucket API token',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'API token is required.'),
  });
  if (!token) return;

  const previous = await credentials.getToken();
  const previousEmail = await credentials.getEmail();
  await credentials.setToken(token.trim());
  if (email.trim()) {
    await credentials.setEmail(email.trim());
  } else {
    await credentials.clearEmail();
    void vscode.window.showWarningMessage(
      'No Bitbucket email was set. Bearer token authentication will be used.',
    );
  }
  try {
    await adapter.listRepositories();
  } catch (error) {
    if (previous) {
      await credentials.setToken(previous);
    } else {
      await credentials.clearToken();
    }
    if (previousEmail) {
      await credentials.setEmail(previousEmail);
    } else {
      await credentials.clearEmail();
    }
    throw error;
  }
  controller.notifyChanged();
  void vscode.window.showInformationMessage('Bitbucket API token stored securely.');
}

async function signOutBitbucket(
  controller: RepositoryController,
  credentials?: BitbucketCredentialStore,
): Promise<void> {
  if (!credentials) {
    throw new RemoteError('unsupported', 'Bitbucket authentication is unavailable in this build.');
  }
  await credentials.clearToken();
  await credentials.clearEmail();
  controller.notifyChanged();
  void vscode.window.showInformationMessage('Bitbucket API token removed.');
}

function requireActive(controller: RepositoryController): RepositorySession | undefined {
  const session = controller.getActive();
  if (!session) {
    void vscode.window.showWarningMessage('Open a remote repository first.');
  }
  return session;
}

function requireCapability(enabled: boolean, feature: string): void {
  if (!enabled) {
    throw new RemoteError('unsupported', `${feature} is not supported by this provider.`);
  }
}

function findWorkspaceFolder(session: RepositorySession): vscode.WorkspaceFolder | undefined {
  return (vscode.workspace.workspaceFolders ?? []).find((folder) => {
    const descriptor = parseRemoteUri(folder.uri);
    return (
      descriptor?.adapterId === session.adapter.id &&
      descriptor.repositoryId === session.repositoryId &&
      descriptor.ref === session.ref
    );
  });
}

function resourceUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (value && typeof value === 'object' && 'resourceUri' in value) {
    const candidate = (value as { resourceUri?: unknown }).resourceUri;
    if (candidate instanceof vscode.Uri) {
      return candidate;
    }
  }
  if (value && typeof value === 'object' && 'resourceStates' in value) {
    const states = (value as { resourceStates?: unknown }).resourceStates;
    if (Array.isArray(states)) {
      return resourceUri(states[0]);
    }
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return active?.scheme === 'remote' ? active : undefined;
}

async function showErrors(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
  }
}
