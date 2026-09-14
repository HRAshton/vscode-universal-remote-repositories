import {
  connectBitbucketDataCenterBridge,
  createBridgeLaunchFromQuery,
} from '@remote/bitbucket-datacenter-adapter';
import * as vscode from 'vscode';
import { activateRemoteRepositories } from './runtime.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const launch = (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => createBridgeLaunchFromQuery(folder.uri.query))
    .find((value) => value !== undefined);
  let recoveryShown = false;
  const adapter = await connectBitbucketDataCenterBridge({
    launch,
    onDisconnect: () => {
      if (recoveryShown || !launch) return;
      recoveryShown = true;
      void vscode.window
        .showWarningMessage('Bitbucket connection closed.', 'Open Bitbucket')
        .then((selection) => {
          if (selection === 'Open Bitbucket')
            return vscode.env.openExternal(vscode.Uri.parse(launch.bitbucketOrigin));
          return undefined;
        });
    },
  });
  await activateRemoteRepositories(context, [adapter]);
}

export function deactivate(): void {}
