import { connectBitbucketDataCenterBridge, createBridgeLaunch } from '@remote/bitbucket-datacenter-adapter';
import * as vscode from 'vscode';
import { activateRemoteRepositories } from './runtime.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const launch = createBridgeLaunch(new URL(globalThis.location.href));
  let recoveryShown = false;
  const adapter = await connectBitbucketDataCenterBridge({
    onDisconnect: () => {
      if (recoveryShown || !launch) return;
      recoveryShown = true;
      void vscode.window
        .showWarningMessage('Bitbucket connection closed.', 'Open Bitbucket')
        .then((selection) => {
          if (selection === 'Open Bitbucket') return vscode.env.openExternal(vscode.Uri.parse(launch.bitbucketOrigin));
          return undefined;
        });
    },
  });
  await activateRemoteRepositories(context, [adapter]);
}

export function deactivate(): void {}
