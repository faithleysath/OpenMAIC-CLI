# OpenMAIC Generator Release Review

- Confirm no implementation change touched `lib/generation`, `lib/prompts`, `lib/document`, `lib/web-search`, `lib/media`, `lib/audio`, `lib/export`, `lib/ai`, `lib/server/classroom-generation.ts`, or `app/api/generate`.
- Read `openmaicUpstreamBaseline` from `package.json` and compare it with the target release tag.
- Review relevant upstream changes with:

```bash
git diff --name-status <old-tag>..<new-tag> -- lib/generation lib/prompts lib/document lib/web-search lib/media lib/audio lib/export lib/ai
git log --oneline <old-tag>..<new-tag> -- lib/generation lib/prompts lib/document lib/web-search lib/media lib/audio lib/export lib/ai
git diff <old-tag>..<new-tag> -- lib/generation lib/prompts lib/document lib/web-search lib/media lib/audio lib/export lib/ai
```

- Port relevant non-PBL changes into this package, update parity fixtures, and run build/typecheck/test/pack before changing `openmaicUpstreamBaseline`.

## npm Trusted Publishing

The packages use npm Trusted Publishing through `.github/workflows/publish-openmaic-cli.yml`.
Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to the publish job.

For each package, configure the following under npmjs.com package Settings > Trusted Publisher:

- Publisher: GitHub Actions
- Organization or user: `faithleysath`
- Repository: `OpenMAIC-CLI`
- Workflow filename: `publish-openmaic-cli.yml`
- Environment: leave empty
- Allowed action: `npm publish`

Trusted Publishers can only be configured after a package exists. For the first release only:

1. Build and test both packages.
2. Pack both packages with pnpm so `workspace:` dependencies are rewritten.
3. Sign in interactively with npm CLI and publish the generator tarball first.
4. Wait until the generator version is visible, then publish the CLI tarball.
5. Configure the Trusted Publisher above on both npm package settings pages.
6. Run this workflow with `dry_run: false` on the next unpublished version to verify OIDC.
7. After OIDC succeeds, set Publishing access to "Require two-factor authentication and disallow tokens" and revoke obsolete automation tokens.

For normal releases, update package versions and push one matching tag. The workflow checks and publishes both packages in dependency order, so do not push both tags for the same commit:

```bash
git tag "@faithleysath/openmaic-generator@<generator-version>" # generator-only release
git tag "@faithleysath/openmaic-cli@<cli-version>"             # normal CLI release
git push origin <the-one-tag-created-above>
```

The workflow publishes the generator before the CLI, skips versions already in npm, verifies the release baseline and tag, checks tarball dependency rewrites, and relies on npm's automatic OIDC provenance.
