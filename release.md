# Releasing @courtmesh/mcp-server

Publishing to npm happens automatically from CI (`.github/workflows/publish.yml`)
whenever a `v*` tag is pushed. The steps below are the exact, complete human
side of cutting a release; nothing here is automated further than that.

## One time setup

Log in to npm locally, under the account that owns `@courtmesh/mcp-server`
(or whichever account is granted publish access to the `@courtmesh` scope):

```bash
npm login
```

This is only needed if you intend to publish by hand as a fallback; the
normal release path below never runs `npm publish` locally.

The repository also needs an `NPM_TOKEN` secret (Settings -> Secrets and
variables -> Actions) holding an npm automation token with publish rights to
`@courtmesh/mcp-server`. That is a one time, per-repository setup step, done
in the GitHub UI, not by a contributor on every release.

## Cutting a release

1. Make sure `main` is clean and up to date, and that `npm test` and
   `npm run test:e2e` both pass locally.
2. Bump the version. Use whichever bump fits the change:

   ```bash
   npm version patch   # bug fixes, no API changes
   npm version minor    # new tools or arguments, backward compatible
   npm version major    # breaking changes
   ```

   `npm version` updates `package.json`, creates a commit, and creates a
   matching `vX.Y.Z` git tag. Also update `SERVER_VERSION` in `src/index.ts`
   and add a `CHANGELOG.md` entry for the new version before running this
   command, and include them in the same commit (`npm version` will refuse
   to run with a dirty working tree, so stage and commit those first, then
   run `npm version patch --no-git-tag-version` style bumps are not needed:
   plain `npm version patch` is enough once everything else is already
   committed, since it only needs to bump `package.json` itself).

3. Push the commit and the tag together:

   ```bash
   git push --follow-tags
   ```

4. Pushing the tag triggers `.github/workflows/publish.yml`, which runs
   `npm ci`, the unit tests, the e2e tests, `npm run build`, then
   `npm publish --access public --provenance` using the repository's
   `NPM_TOKEN` secret. Watch the Actions tab for that run; the package is
   live on npm once it goes green.

5. Sanity check the published package:

   ```bash
   npm view @courtmesh/mcp-server version
   npx -y @courtmesh/mcp-server@latest --help
   ```

## If CI cannot publish

Only as a fallback, and only after `npm login` above:

```bash
npm run build
npm publish --access public
```

This skips provenance (that needs the CI OIDC token) and skips the test
gate, so prefer the tag-push path whenever CI is available.
