# Privacy

**Short version: nothing leaves your computer.** There is no server, no account,
no analytics, no telemetry and no remote configuration.

## What the extension reads

To find videos it looks at the pages you open:

- **Network requests of the current tab** (`webRequest`): URLs, response
  `Content-Type` and size, and the body of POST requests, to spot media URLs.
  It only observes — it never blocks or modifies a request.
- **The page itself** (content scripts): `<video>` elements, inline JSON and
  the buffers a player feeds to `MediaSource`, so it can rebuild streams that
  have no downloadable URL.

## What it stores, and where

| What | Where | For how long |
|---|---|---|
| Media found per tab (URL, type, size, thumbnail) | `chrome.storage.session` (memory) | Until the tab closes or the browser restarts |
| The `Referer`, `Origin` and `User-Agent` sent with a media request | Same, alongside the item | Same |
| Your settings | `chrome.storage.local` | Until you uninstall |
| Captured player buffers | Page memory | Until you save, or leave the page |

`Cookie` and `Authorization` headers are **never** stored. When a download
needs your session, the browser attaches your cookies itself, the same way it
would for the page.

## Network requests the extension makes

Only to the sites you're already on, and only for media you chose to preview or
download (plus small reads of HLS/DASH manifests to list qualities, and a frame
to make a thumbnail). Nothing is ever sent to the author or any third party.

## Permissions, and why

| Permission | Why |
|---|---|
| `webRequest`, `<all_urls>` | See which media a page loads, on any site |
| `scripting`, `tabs` | Run the detector in the tab and know which tab the popup is for |
| `downloads` | Save files |
| `offscreen` | Download, decrypt (AES-128 HLS) and stitch segments outside the popup |
| `declarativeNetRequestWithHostAccess` | Send the same `Referer` the page used, so CDNs accept the request |
| `storage`, `unlimitedStorage` | Remember settings and the per-tab list |
| `contextMenus` | Right-click entries: "find videos on this page" and "extract this video" |

Questions: open an issue.
