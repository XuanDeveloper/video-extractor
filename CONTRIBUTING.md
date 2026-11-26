# Contributing

Bug reports with a page that reproduces the problem are the most valuable
contribution. PRs are welcome too — small and focused is easiest to review.

## Setup

You need **Node 20+** and **ffmpeg** on your `PATH` (the tests generate their
own media with it — color bars and a sine tone, nothing downloaded).

```bash
npm install
npm run check      # lint + unit tests + manifest sanity check
npm run test:e2e   # real browser with the extension loaded (~1 min)
```

Load `extension/` with **Load unpacked** in `chrome://extensions`. After editing,
hit ↻ on the extension card and reload the tab — content scripts only update on
a fresh page.

To run the browser tests on Brave or Edge instead of Chrome for Testing:

```bash
BROWSER="/path/to/brave" PROFILE=".profile-brave" npm run test:e2e
```

## Ground rules

- **No DRM circumvention.** Widevine/PlayReady/FairPlay/`SAMPLE-AES` content is
  detected and blocked; PRs that change that won't be merged. Same for code that
  defeats a site's signatures, tokens or anti-bot measures.
- **No new permissions** without a clear reason in the PR.
- **Nothing leaves the machine.** No analytics, no remote calls. See
  [PRIVACY.md](PRIVACY.md).
- **No build step.** The extension is plain ES modules loaded as-is; keep it that
  way unless there's a strong reason.
- New parsing or remuxing logic needs a test in `tests/unit/`. Behavior visible
  in the popup is best covered in `tests/e2e/`.

## Code layout

See [Architecture](README.md#architecture) in the README. Code comments are in
Portuguese (the UI is too); either language is fine in PRs.

## Releasing (maintainer)

1. Bump `version` in both `extension/manifest.json` and `package.json`.
2. Add an entry to `CHANGELOG.md`.
3. `git tag v1.2.3 && git push --tags` — the Release workflow builds the zip and
   publishes it with a SHA-256 checksum.
