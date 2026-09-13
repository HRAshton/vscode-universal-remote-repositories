import { BitbucketRemoteAdapter } from '@remote/bitbucket-adapter';
import type * as vscode from 'vscode';
import { BitbucketCredentialStore } from './auth.js';
import { activateRemoteRepositories } from './runtime.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const credentials = new BitbucketCredentialStore(context.secrets);
  const adapter = new BitbucketRemoteAdapter({
    getToken: async () => credentials.getToken(),
    getEmail: async () => credentials.getEmail(),
  });
  await activateRemoteRepositories(context, [adapter], credentials);
}

export function deactivate(): void {}
