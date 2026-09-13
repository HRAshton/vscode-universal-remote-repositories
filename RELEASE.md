# Release 1.0 Checklist

## External blockers

- Enable GitHub private vulnerability reporting for the repository.
- Protect `v*` tags from modification or deletion, require approval on the `release` environment, and
  enable immutable releases if the repository offers them.
- Revoke and rotate the credential exposed by the removed legacy `src/config.ts`.
- Confirm GitHub contains only the rewritten `main` history and no legacy refs containing that credential.
- Run the opt-in private Bitbucket acceptance suite, including concurrent stale-parent upload behavior.

## Release gate

1. Start from a clean checkout and run `pnpm install --frozen-lockfile`.
2. Run `pnpm run ci`.
3. Run `pnpm run package:vsix` and inspect the file list printed by `vsce package`.
4. Install and test the generated VSIX in VS Code Desktop and VS Code Web.
5. Create signed tag `v1.0.0`.
6. Push the tag and approve the `release` environment. The workflow publishes the VSIX and its SHA-256
   checksum to a GitHub release and records GitHub artifact provenance for the VSIX.
7. Download the released files, run `sha256sum -c universal-remote-repositories.vsix.sha256`, and verify
   provenance:

   ```sh
   gh attestation verify universal-remote-repositories.vsix \
     --repo HRAshton/vscode-universal-remote-repositories
   ```

Use a patch release for normal rollback. Delete a GitHub release only for security or data-loss faults.
