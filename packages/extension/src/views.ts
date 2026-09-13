import type { RepositorySession } from '@remote/core';
import * as vscode from 'vscode';
import type { RepositoryController } from './controller.js';

export type RemoteViewKind = 'pullRequests' | 'statuses' | 'pipelines';

export class RemoteTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  private readonly listener: vscode.Disposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly kind: RemoteViewKind,
    private readonly controller: RepositoryController,
  ) {
    this.listener = controller.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }
    const session = this.controller.getActive();
    if (!session) {
      const empty = new vscode.TreeItem('Open a remote repository');
      empty.contextValue = 'empty';
      return [empty];
    }
    return this.load(session);
  }

  dispose(): void {
    this.listener.dispose();
    this.changeEmitter.dispose();
  }

  private async load(session: RepositorySession): Promise<vscode.TreeItem[]> {
    if (this.kind === 'pullRequests') {
      return (await session.adapter.listPullRequests(session.repositoryId)).map((pullRequest) => {
        const item = new vscode.TreeItem(`#${pullRequest.id.replace(/^pr-/, '')} ${pullRequest.title}`);
        item.description = `${pullRequest.sourceBranch} to ${pullRequest.targetBranch}`;
        item.tooltip = `${pullRequest.state}: ${pullRequest.description || pullRequest.title}`;
        item.iconPath = new vscode.ThemeIcon('git-pull-request');
        return item;
      });
    }
    if (this.kind === 'statuses') {
      if (!session.adapter.capabilities.statuses) return [];
      return (await session.adapter.listCommitStatuses(session.repositoryId, session.baseCommit)).map(
        (status) => {
          const item = new vscode.TreeItem(status.name);
          item.description = status.state;
          item.tooltip = status.description;
          item.iconPath = checkIcon(status.state);
          return item;
        },
      );
    }
    if (!session.adapter.capabilities.pipelines) return [];
    return (await session.adapter.listPipelines(session.repositoryId, session.baseCommit)).map((pipeline) => {
      const item = new vscode.TreeItem(pipeline.name);
      item.description = pipeline.state;
      item.iconPath = checkIcon(pipeline.state);
      return item;
    });
  }
}

function checkIcon(state: 'pending' | 'running' | 'success' | 'failure'): vscode.ThemeIcon {
  switch (state) {
    case 'success':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'failure':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'running':
      return new vscode.ThemeIcon('sync~spin');
    case 'pending':
      return new vscode.ThemeIcon('clock');
  }
}
