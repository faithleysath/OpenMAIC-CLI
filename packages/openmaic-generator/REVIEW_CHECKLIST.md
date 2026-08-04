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
