import type { RepositorySession, WorkingTreeChange } from '@remote/core';
import * as vscode from 'vscode';
import type { RepositoryController } from './controller.js';
import { createRemoteUri, sessionKey } from './uri.js';

type ScmEntry = {
  sourceControl: vscode.SourceControl;
  changes: vscode.SourceControlResourceGroup;
};

export class ScmController implements vscode.Disposable {
  private readonly entries = new Map<string, ScmEntry>();
  private readonly listener: vscode.Disposable;

  constructor(private readonly controller: RepositoryController) {
    this.listener = controller.onDidChange(() => void this.sync());
    void this.sync();
  }

  getSourceControl(key: string): vscode.SourceControl | undefined {
    return this.entries.get(key)?.sourceControl;
  }

  dispose(): void {
    this.listener.dispose();
    for (const entry of this.entries.values()) {
      entry.sourceControl.dispose();
    }
  }

  private async sync(): Promise<void> {
    const activeKeys = new Set<string>();
    for (const session of this.controller.getAll()) {
      if (!session.adapter.capabilities.writeFiles) {
        continue;
      }
      const key = sessionKey({
        adapterId: session.adapter.id,
        repositoryId: session.repositoryId,
        ref: session.ref,
      });
      activeKeys.add(key);
      let entry = this.entries.get(key);
      if (!entry) {
        const root = createRemoteUri(session.adapter.id, session.repositoryId, session.ref);
        const sourceControl = vscode.scm.createSourceControl('remote', 'Remote', root);
        const changes = sourceControl.createResourceGroup('changes', 'Changes');
        changes.hideWhenEmpty = false;
        sourceControl.acceptInputCommand = {
          command: 'remote.commit',
          title: 'Commit',
          arguments: [key],
        };
        entry = { sourceControl, changes };
        this.entries.set(key, entry);
      }
      await this.refreshEntry(session, entry);
    }

    for (const [key, entry] of this.entries) {
      if (!activeKeys.has(key)) {
        entry.sourceControl.dispose();
        this.entries.delete(key);
      }
    }
  }

  private async refreshEntry(session: RepositorySession, entry: ScmEntry): Promise<void> {
    try {
      const changes = await session.getChanges();
      entry.changes.resourceStates = changes.map((change) => this.toResourceState(session, change));
      entry.sourceControl.count = changes.length;
    } catch (error) {
      console.error('Failed to refresh remote source control.', error);
    }
  }

  private toResourceState(
    session: RepositorySession,
    change: WorkingTreeChange,
  ): vscode.SourceControlResourceState {
    const uri = createRemoteUri(session.adapter.id, session.repositoryId, session.ref, change.path);
    return {
      resourceUri: uri,
      command: {
        command: 'remote.openChange',
        title: 'Open Change',
        arguments: [uri],
      },
      contextValue: 'remoteChange',
      decorations: {
        iconPath: new vscode.ThemeIcon(iconForChange(change.type)),
        tooltip:
          change.type === 'renamed' ? `Renamed from ${change.originalPath ?? ''}` : capitalize(change.type),
        strikeThrough: change.type === 'deleted',
      },
    };
  }
}

function iconForChange(type: WorkingTreeChange['type']): string {
  switch (type) {
    case 'added':
      return 'diff-added';
    case 'deleted':
      return 'diff-removed';
    case 'renamed':
      return 'diff-renamed';
    case 'modified':
      return 'diff-modified';
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
