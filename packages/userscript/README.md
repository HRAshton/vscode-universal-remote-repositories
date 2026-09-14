# Bitbucket Data Center VS Code bridge

Build the userscript for one Data Center installation and the local static Code - OSS workbench:

```powershell
$env:VSCODE_STATIC_URL = 'http://localhost:8080/'
$env:BITBUCKET_URL = 'https://bitbucket.example.com/bitbucket/' # optional: narrows @match to this origin
pnpm --filter @remote/bitbucket-datacenter-userscript build
pnpm --filter universal-remote-repositories build:datacenter
```

The GitHub Release userscript uses a broad match so it can work with any Data Center origin. Set
`BITBUCKET_URL` for a deployment-specific build. Install `dist/bitbucket-vscode.user.js` in Tampermonkey. On a repository page, **Open VS Code** opens the
configured local workbench in a top-level window. The user-clicked launch creates a one-time capability and a
private message channel tied to that exact child window and the configured local origin.

The bridge exposes only `RemoteAdapter` operations. It rejects arbitrary HTTP requests and never forwards
cookies, headers, or tokens to the workbench. Keep the Bitbucket tab open; reopen it and click **Open VS Code**
to recover after a disconnect.

`BLOCK_FILE_WRITES` is an immutable userscript-bundle constant and defaults to `true`. It must remain true
until a live target installation proves conditional file updates reject stale parents atomically.
