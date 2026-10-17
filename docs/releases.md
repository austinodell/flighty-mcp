# Container releases

The CI workflow publishes `ghcr.io/swiftyspiffy/flighty-mcp` only after the lint,
type, Python test matrix and container checks pass. Pull requests never publish.
Docker actions are pinned to full commit IDs. Authentication uses the workflow's
short-lived `GITHUB_TOKEN` with `packages: write`, not a saved registry password.

Published platforms: `linux/amd64` and `linux/arm64`.

| Trigger | Image tags |
| --- | --- |
| Push to `main`, or manually run CI on `main` | `latest`, `sha-<full commit>` |
| Push a version tag, for example `v0.1.0` | `0.1.0`, `sha-<full commit>`; stable versions also update `latest` |

Before creating a version tag, update the package version in `pyproject.toml` and
refresh `uv.lock`. The container workflow does not create Git tags or GitHub releases.

## First publication

GitHub creates new container packages as private. Publishing a repository does not
automatically make its container package public. Before advertising the image for
anonymous downloads, the owner must manually open the
[package settings](https://github.com/users/swiftyspiffy/packages/container/flighty-mcp/settings)
and change the package visibility to public. The workflow does not change visibility.

See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

The Docker build context only includes application source, package metadata,
README and license. Account tokens and diagnostic attachments must never be
passed to builds. The private deployment fork is not published by this workflow.
