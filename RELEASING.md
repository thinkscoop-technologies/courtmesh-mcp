# Releasing @courtmesh/mcp-server

Releases are published by GitHub Actions when a `v*` tag is pushed. The workflow is `.github/workflows/publish.yml`: it checks that the tag matches `package.json`, runs `npm ci`, the unit tests, the end to end tests and the build, then `npm publish --access public --provenance`.

## One time setup (a human with the right accounts)

1. Create the npm organization `courtmesh` at https://www.npmjs.com/org/create (free plan is enough for public packages) and add the people who may publish as members with the owner or admin role. The package is `@courtmesh/mcp-server`, so the scope must exist and be owned by this organization.
2. On npm, create an automation access token (Account menu, Access Tokens, Generate New Token, Classic, type Automation) or a granular token with read and write on the `@courtmesh` scope. An automation token bypasses two factor prompts, which CI needs.
3. In GitHub, open `thinkscoop-technologies/courtmesh-mcp`, Settings, Secrets and variables, Actions, New repository secret. Name it `NPM_TOKEN` and paste the token.
4. Make sure the repository is public. npm provenance requires a public repository and the `id-token: write` permission already set in the workflow.

## Every release

1. Update `version` in `package.json` and `SERVER_VERSION` in `src/index.ts` (they must match) and add a section to `CHANGELOG.md`.
2. Run the checks locally:

   ```bash
   npm ci
   npm test
   npm run test:e2e
   npm pack --dry-run
   ```

3. Merge to `main`.
4. Tag and push the tag (the tag must be `v` plus the exact `package.json` version):

   ```bash
   git checkout main && git pull
   git tag v0.5.0
   git push origin v0.5.0
   ```

5. Watch the Publish workflow. When it is green, confirm with `npm view @courtmesh/mcp-server version` and `npx -y @courtmesh/mcp-server@latest --help`.

## Hosted server

The hosted endpoint at `https://mcp.courtmesh.ai/mcp` runs this package in Streamable HTTP mode. Publishing to npm does not update it: after a release, redeploy the hosted instance from the new tag so it exposes the same tools, and check that `GET /health` reports the new version.

## If a release goes wrong

A published npm version cannot be replaced. Fix forward with a new patch version. Within 72 hours of publishing you can `npm unpublish @courtmesh/mcp-server@<version>` if nothing depends on it; otherwise use `npm deprecate`.
