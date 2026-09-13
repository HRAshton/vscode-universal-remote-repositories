# Bitbucket Data Center userscript host

This package proves the same-origin artificial-page approach without requiring a Bitbucket plugin or a
separate web server. On repository pages the userscript adds an **Open VS Code** button. The button opens an
iframe at `<bitbucket-context-path>/__remote-vscode__/`; at document start the userscript replaces Bitbucket's
404 document with an isolated application shell.

## Build and install

First build the self-contained session probe:

```powershell
pnpm --filter @remote/bitbucket-datacenter-userscript build:demo
```

Commit `dist/demo-bootstrap.js` to a repository on the Data Center instance. Use the resulting full commit
ID in its raw URL, then calculate the SHA-384 integrity value of the exact committed file and build both
host artifacts:

```powershell
$bootstrap = Resolve-Path 'packages/userscript/dist/demo-bootstrap.js'
$sha384 = [Security.Cryptography.SHA384]::Create()
$integrity = 'sha384-' + [Convert]::ToBase64String($sha384.ComputeHash([IO.File]::ReadAllBytes($bootstrap)))
$env:BITBUCKET_CONTEXT_PATH = '/bitbucket' # Use an empty string when Bitbucket is hosted at /
$env:BITBUCKET_BOOTSTRAP_URL = 'https://bitbucket.example.com/bitbucket/projects/TOOLS/repos/vscode/raw/dist/demo-bootstrap.js?at=<full-commit-id>'
$env:BITBUCKET_BOOTSTRAP_INTEGRITY = $integrity
pnpm --filter @remote/bitbucket-datacenter-userscript build
pnpm --filter universal-remote-repositories build:datacenter
```

Install `dist/bitbucket-vscode.user.js` in Tampermonkey. Its exact `@match` origin and context path are derived
from the pinned bootstrap URL and `BITBUCKET_CONTEXT_PATH`; the build cannot accidentally target every site.

The userscript refuses to build with a branch or tag bootstrap URL. At runtime the browser also enforces the
embedded SHA-384 digest before executing the module. A successful demo reports the repository's default
branch, compatible browse response shape, and Data Center version when that endpoint is available. Record
that result as the live compatibility proof for the deployed Data Center version.

## Bootstrap contract

Before loading the configured ES module, the shell defines `window.__REMOTE_VSCODE_CONTEXT__`:

```ts
{
  provider: 'bitbucket-datacenter';
  origin: string;
  contextPath: string;
  project: string;
  repository: string;
  ref?: string;
}
```

A Code-OSS bootstrap should be bundled into one integrity-checked module. It should read this value, create
the corresponding
`remote://bitbucket-datacenter/<repository-id>?ref=<ref>` workspace URI, and start the workbench with the
Data Center extension from `packages/extension/dist/datacenter`. The shell accepts only the exact bootstrap
module baked into the userscript, from the current Bitbucket origin, with matching integrity. Dynamic
Code-OSS assets need their own immutable URLs or integrity controls. Whether a full Code-OSS build can load
from raw repository endpoints still depends on the installation's MIME types and Content Security Policy;
the demo proves the prerequisite path first.
