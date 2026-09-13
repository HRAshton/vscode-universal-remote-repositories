import { FakeRemoteAdapter } from '@remote/fake-adapter';
import type * as vscode from 'vscode';
import { activateRemoteRepositories } from './runtime.js';

export function activate(context: vscode.ExtensionContext): Promise<void> {
  return activateRemoteRepositories(context, [new FakeRemoteAdapter()]);
}

export function deactivate(): void {}
