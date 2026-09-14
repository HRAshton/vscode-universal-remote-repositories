# Universal Remote Repositories

Universal Remote Repositories is a browser-first VS Code extension for browsing Bitbucket Cloud repositories
without a local clone. The core remains provider-neutral; the production bundle contains the Bitbucket adapter.

## Installation

Download `universal-remote-repositories.vsix` from the
[latest GitHub release](https://github.com/HRAshton/vscode-universal-remote-repositories/releases/latest),
then run **Extensions: Install from VSIX...** in VS Code. Release provenance can be verified with:

```sh
gh attestation verify universal-remote-repositories.vsix \
  --repo HRAshton/vscode-universal-remote-repositories
```

## Workspace

- `@remote/core` owns normalized types, safe repository paths, persistent overlays, working-tree behavior,
  atomic commits, refresh behavior, and typed errors. It has no VS Code or provider SDK dependencies.
- `@remote/fake-adapter` implements every adapter capability with deterministic in-memory data.
- `@remote/bitbucket-adapter` implements Bitbucket Cloud REST API v2 with scoped API-token authentication.
- `@remote/bitbucket-datacenter-adapter` implements Bitbucket Data Center REST API 1.0 through a narrow,
  authenticated browser-tab bridge.
- `universal-remote-repositories` is the thin VS Code web extension. It owns URI translation and VS Code UI only.
- `@remote/bitbucket-datacenter-userscript` launches the local workbench from a Bitbucket tab and performs the
  authenticated, typed provider RPC without exposing session cookies.
- `@remote/integration-tests` contains reusable adapter contract tests and end-to-end core behavior tests.
- `@remote/e2e` starts VS Code Web with `@vscode/test-web` and drives a browser smoke test with Playwright.

The canonical workspace URI is:

```text
remote://<adapter-id>/<repository-id>/<path>?ref=<ref>
```

The fake repository is available only in test builds at `remote://fake/demo?ref=main`.

## Development

Requirements are Node.js 22 or later and pnpm 10.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Build the Data Center extension and userscript with `pnpm build:datacenter`; set `BITBUCKET_URL` only to narrow
the userscript to one origin, and `VSCODE_STATIC_URL` when the workbench is not on localhost. The generated
top-level relay script must be loaded by the workbench so its extension-host worker can receive the bridge.
Deployment instructions are in `packages/userscript/README.md`. The Data Center extension is emitted separately
under `packages/extension/dist/datacenter`; it never overwrites the Cloud extension bundle.

Run `pnpm test:e2e` after installing the Chromium browser with
`pnpm exec playwright install chromium`. The first run also downloads the selected VS Code Web build.

In VS Code, run **Remote: Set Bitbucket API Token**, then **Remote: Open Repository**. Provide an email with
the token to use Basic authentication; leaving it blank uses Bearer authentication. Credentials stay in VS Code
SecretStorage. Bitbucket file writes remain disabled until its API proves atomic stale-parent rejection.

## Consistency model

Each repository session reads from one immutable base commit. Local operations merge a versioned overlay
onto that snapshot. A commit sends all file changes atomically with the expected branch head. The overlay
is cleared only after the adapter accepts the commit.

Refresh checks the current branch head every 30 seconds. Unrelated remote changes advance the base commit
while retaining local changes. Overlapping remote changes mark conflicts and leave the overlay and base
snapshot unchanged. The user must discard or otherwise resolve those changes before committing.

Overlay keys include adapter ID, repository ID, and ref:

```text
remote.overlay.v1.<adapter-id>/<repository-id>?ref=<ref>
```

Legacy provider overlays are not reinterpreted. Their repository identities and base snapshots cannot be
mapped safely to the demo repository. Existing keys remain untouched, so rolling back to the previous
extension preserves its local data.

## Writing an adapter

Implement `RemoteAdapter` from `@remote/core` and register the adapter during extension activation. Keep
provider SDK types inside the adapter package. Return normalized core values from the public boundary.

Important contract rules:

1. `resolveRef` returns an immutable commit ID.
2. `listDirectory` and `readFile` read that exact commit, never a moving branch.
3. `commit` validates `expectedHead` before applying any change and fails atomically with
   `RemoteConflictError` when the branch moved.
4. Returned byte arrays and records must not expose mutable adapter state.
5. Invalid repository IDs, refs, paths, and branch names must fail with typed core errors.

Use `describeAdapterContract` from `@remote/integration-tests` when adding an adapter. Add provider-specific
authentication and authorization only inside that adapter. Never place credentials in source code or
extension settings that sync as plaintext.

## Migration and rollback

This repository is the canonical provider-neutral rewrite. Old schemes and commands are not supported.
Rollback is a normal Git revert or installation of an earlier VSIX; installing the extension does not migrate
or mutate remote repository data.
