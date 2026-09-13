# Universal Remote Repositories

Browse Bitbucket Cloud repositories in VS Code without a local clone. This browser-first extension
supports repository browsing, branches, history, pull requests, commit statuses, and pipelines.

## Authentication

Create a single-purpose Bitbucket Cloud API token, then run **Remote: Set Bitbucket API Token**. Supply the
email associated with the token to use HTTP Basic authentication. If you leave the email blank, the extension
warns that it will send the token to `api.bitbucket.org` as a Bearer token instead. Credentials stay in VS Code
SecretStorage. Use the smallest scopes needed:

- `read:workspace:bitbucket` and `read:repository:bitbucket` for browsing.
- `write:repository:bitbucket` for branch management.
- Pull-request read/write scopes for pull-request features.
- Pipeline read scope for pipeline results.

Run **Remote: Remove Bitbucket API Token** to delete the stored token.

## Write safety

Bitbucket file editing is currently disabled. Branch and pull-request actions remain available when the token
has matching scopes. File commits will be enabled only after Bitbucket's upload API proves atomic
stale-parent rejection. This prevents concurrent branch changes from being overwritten.

This project is not affiliated with or endorsed by Atlassian.
