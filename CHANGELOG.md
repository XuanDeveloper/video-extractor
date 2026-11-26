# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-11-26

First public release.

### Detection
- Progressive files and audio, HLS (`.m3u8`) and DASH (`.mpd`), found through
  `webRequest`, POST bodies, `fetch`/`XHR` responses and the DOM.
- Player capture for `MediaSource` streams with no downloadable URL.
- Assertive list: fragments, variant playlists, ads, UI sounds, tiny files,
  duplicate signed URLs and expired manifests are hidden ("Show everything" brings
  them back).
- URLs with JSON-escaped slashes (`https:\/\/…`) are now detected.

### Download
- Parallel HLS/DASH segment download with retries, AES-128 decryption, byte ranges.
- Player capture saves video + audio in one WebM/MKV, remuxed without re-encoding.
- "Capture all" plays the video muted and accelerated so the player fetches the
  whole thing, then restores it.

### Popup
- Thumbnails and an embedded preview player (file, HLS with quality switch, DASH).
- Download queue with progress, `ffmpeg` command and URL copy.

### Safety
- DRM (Widevine, PlayReady, FairPlay, `SAMPLE-AES`, EME) is detected and blocked.
- `Cookie` and `Authorization` headers are never stored.

[1.0.0]: https://github.com/XuanDeveloper/video-extractor/releases/tag/v1.0.0
