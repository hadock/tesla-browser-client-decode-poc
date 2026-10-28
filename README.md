# Tesla Browser — Client Decode PoC

**Private. Responsible disclosure only.** Companion to
[`tesla-browser-media-bypass-poc`](https://github.com/hadock/tesla-browser-media-bypass-poc).

This PoC proves the same Drive-mode media-playback gap **entirely in the
browser**: a page loads an MP4, decodes it client-side, and renders JPEG
frames into an `<img>` (or canvas) while playing PCM through the Web Audio
API. A `<video>` element is never shown. No Lambda, no WebSocket streamer.

## Why this exists

Tesla's in-car browser blocks HTML5 `<video>` (and equivalent media elements)
while the vehicle is in Drive. That control does **not** extend to:

1. Rapidly swapping the `src` of an `<img>` with sequential JPEG frames
   (or redrawing a `<canvas>`), and
2. Playing PCM audio through the Web Audio API.

The sibling PoC streams pre-extracted frames over WSS from Lambda. This PoC
shows the same end state with **no server-side streamer** — just a static
site that hosts the source MP4s same-origin and does the decode in the page.

## Architecture

```
CloudFront (single distribution, HTTPS)
  /              → SPA (index.html, app.js, …)
  /videos/*.mp4  → H.264/AAC source clips (~70s)
         │ same-origin fetch (no CORS)
         ▼
Browser (Tesla in-car / desktop)
  Prefer:  WebCodecs VideoDecoder → canvas → JPEG <img>
  Fallback: hidden <video> → canvas.drawImage → JPEG <img>
  Audio: Web Audio API (decodeAudioData) — element stays muted
```

Same-origin `/videos/*` via the shared CloudFront distribution means the
page can `fetch()` and decode the MP4 without CORS headaches. External
paste-URL input is provided for completeness; those only work when the
remote origin allows CORS.

## Hosted clips (CC BY 3.0)

| Slug | Artist — Title | Segment |
|------|----------------|---------|
| `patricia` | Patricia Janečková — La Danza (Rossini) | 50–120s |
| `rickastley` | Rick Astley — Never Gonna Give You Up (live) | 45–115s |
| `spencerx` | Spencer X — Be Somebody (beatbox) | 15–85s |
| `decadentes` | Los Auténticos Decadentes — Yo No Soy Tu Prisionero (live) | 30–100s |

Attribution is shown under the player. Full license:
https://creativecommons.org/licenses/by/3.0/

## Try it

1. Open the CloudFront URL (printed by `scripts/deploy.sh`).
2. Pick a hosted clip (or paste a CORS-enabled MP4 URL).
3. Hit **Play**. Confirm the HUD shows `Renderer: … JPEG <img> (not <video>)`.
4. In the car: park, open the URL, shift to **Drive**, Play. Baseline a
   normal `<video>` page first so the contrast is clear.

## Deploy

Auth with short-lived STS from `AWS_POC_CREDENTIALS_JSON` (nested
`credentials` shape), then:

```bash
./scripts/deploy.sh            # stack + frontend + videos + invalidate
./scripts/deploy.sh frontend   # SPA only
./scripts/deploy.sh videos     # MP4s only
```

Stack name: `tesla-browser-client-decode-poc` · Region: `us-east-1` ·
Account: `<AWS_ACCOUNT_ID>`.

## Local smoke test

```bash
cd frontend
ln -sfn ../media videos
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

## Repo layout

```
frontend/     SPA (index.html, app.js, styles.css, catalog.json, vendor/mp4box)
media/        Source ~70s H.264/AAC MP4s (uploaded to /videos/)
infra/        CloudFormation (S3 + CloudFront OAC)
scripts/      deploy.sh
DISCLOSURE.md Bugcrowd framing
```

## Security / disclosure

See `DISCLOSURE.md` and `SECURITY.md`. This is intentional, minimal, and
not a consumer product. Invite only Tesla / Bugcrowd reviewers.
