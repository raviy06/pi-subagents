# Fork maintenance, packaging and activation

## Identity and bounded delta

- Fork repository: https://github.com/raviy06/pi-subagents
- Upstream repository: https://github.com/nicobailon/pi-subagents
- Fork npm identity: `@raviy06/pi-subagents`
- Initial prepared version: `0.81.1`
- Baseline: upstream `1a80e24e` (includes commits after upstream v0.81.0).
- Preserve upstream authorship, license, tool/event names and configuration contracts.

The fork adds read-only `activityStatus` v1 for companion UIs and test-environment
corrections. It does not replace the runner, broaden permissions, change model
selection, add a task store, or automatically delegate work.

Use the scoped package prefix for direct imports, for example:

```ts
import type { ActivityStatus } from "@raviy06/pi-subagents/shared-types";
```

Upstream docs may still show `pi-subagents/...`; substitute the scoped package
name for fork consumers. Do not rename RPC channels or config keys to match npm.
Prefer event-bus APIs where an independently installed companion cannot resolve
a runtime package import.

## Local validation and packaging

Use `.nvmrc` (Node 24) to match the test CI major version:

```sh
nvm install
nvm use
npm ci --ignore-scripts
npm run typecheck
npm run test:all
npm run build:pkg
npm run check:release -- --packed
npm run pack:pkg
```

The source checkout stays `private: true`; only `dist-pkg` is distributable.
Generated package metadata must say `@raviy06/pi-subagents`, never upstream's
name. `test/smoke/clean-install.mjs` tests the actual tarball in a pristine host
and extension install and supports the scoped node_modules path.

The legacy `install.mjs` is intentionally non-mutating and not exposed as an npm
binary. Even `--remove` fails with native package-manager guidance; it must not
clone, overwrite, or delete an upstream shared-directory installation.

## Release checklist

Every new extension PR must include a version bump **before opening the PR**.
Additional commits to an unpublished PR share that prepared version. Keep the
manifest, both root lockfile versions, release tests and dated changelog aligned.
Verify the version is newer than fork main and not already published before merge.

1. Confirm control of the npm `@raviy06` scope. Local login or trusted publishing
   must be configured explicitly; a matching GitHub username is not proof.
2. Configure npm trusted publishing for `raviy06/pi-subagents`, workflow
   `release.yml`, environment `npm`. Establish the scoped package/initial
   publication using npm's supported account flow if required.
3. Configure required reviewers for the fork's GitHub `npm` environment.
   Merely naming an environment does not create an approval policy.
4. Verify full tests and packed smoke, and merge the release PR into fork main.
5. After a successful **main push** Tests workflow, Publish queues a deployment
   requiring `npm` environment approval. Manual dispatch on main is a recovery
   option; it also requires successful main CI for that exact commit. The workflow
   checks out that commit, revalidates/builds, treats only npm HTTP 404 as absent,
   and skips republishing existing versions. It publishes with provenance/public
   scoped access and creates a `fork-v<version>` GitHub release (distinct from
   inherited upstream tags). PR workflows never trigger publication.
6. Verify the actual npm version before telling users to update.

The stable aggregate `CI` check requires every existing native/platform smoke,
package/release-policy checks, workflow validation and CodeQL to succeed. PR base
comparison enforces a version bump; Dependabot PRs need one too before merge.

No upstream token or trusted-publisher configuration is assumed inherited.
Do not publish the root source or dispatch a workflow merely to test metadata.

## Explicit activation (not performed automatically)

1. Finish or deliberately stop active subagent work before replacing its owner.
2. Record `pi list` and back up the relevant package settings/configuration.
3. Disable/remove the exact upstream package source shown by `pi list` (for a
   standard npm install, `pi remove npm:pi-subagents`). Also check for legacy
   manually loaded extension paths. Do not delete config or transcripts.
4. Install exactly one owner: the published scoped fork, or an explicitly selected
   local `dist-pkg` path for development. Do not load both upstream and fork.
5. Start a fresh test session, inspect `/subagents-doctor`, and verify public RPC
   `ping` advertises `activityStatus: { version: 1 }` before enabling a companion.
6. For the compact UI, use pi-minimal >=0.2.3. Disable duplicate upstream live
   widgets only after the companion is working and with a reversible config edit.

The folder/config names and tool names are deliberately compatible; duplicate
owners would conflict, so side-by-side extension loading is unsupported.

## Rollback

Disable/remove the scoped fork source, restore the recorded upstream package
source and prior widget settings, then start a fresh session. Keep plan/task data
and transcripts. Never stop unrelated sessions, delete dirty worktrees, or mutate
execution state solely because the UI is being disabled.

## Upstream synchronization

Keep `origin` pointing to the fork and `upstream` to nicobailon. Review upstream
changes on a separate sync branch; retain a record of the last imported commit.
Re-run activity-contract, package-identity, full-suite and packed-install tests
before merging. Keep package identity/release policy as a fork-specific delta.
Do not forward fork publishing changes upstream. An upstream API contribution is
separate and requires explicit approval; if upstream gains the same capability,
review removing the fork delta instead of maintaining duplicate implementations.
