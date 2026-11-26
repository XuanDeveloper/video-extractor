# Security

This extension runs on every page with broad permissions, so security reports
matter more than most.

## Reporting

Please **don't open a public issue**. Use
[GitHub's private vulnerability reporting](https://github.com/XuanDeveloper/video-extractor/security/advisories/new)
with a description and, if you can, a page that reproduces it.

I'll acknowledge within a week. This is a personal project, so there's no bug
bounty — but you'll be credited in the release notes if you want.

## In scope

- A page being able to read data from the extension, other tabs, or other origins
  through the extension
- Code in the page's world (`page-hook.js`, `mse-mux.js`) that a page can abuse
  to break out of its own origin
- Headers or URLs leaking somewhere they shouldn't (e.g. `Cookie`/`Authorization`
  being stored or replayed)

## Out of scope

- A page detecting that the extension is installed
- Anything that requires a malicious extension or local access to already be there

## Supported versions

Only the latest release.
