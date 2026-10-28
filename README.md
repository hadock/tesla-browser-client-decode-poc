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
python3 tools/build_chunks.py  # bundle pack frames into 20-frame chunks
./scripts/deploy.sh packs      # JPEG+PCM packs (frames + chunks)
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

## CloudWatch browser logs

Same-origin `POST /api/logs` ships structured JSON lines (`level`, `event`, `stage`, `path`, `clip`, `sessionId`, `ua`, `msg`) into log group `/tesla-browser-client-decode-poc/browser`.

Saved Insights queries (created by `scripts/deploy.sh`):

- **tesla-client-decode-car-failures** — timeouts, decoder errors, pack fallbacks, errors
- **tesla-client-decode-session** — paste `sessionId` from the page HUD into the filter
- **tesla-client-decode-heartbeat** — pack-player heartbeat trend (every 5s): `lagMs`
  (picture behind the audio clock), `bufAheadMs`, `loadP50`/`loadP95` per request,
  `kbps`, `inflight`, `liveImgs`, `liveBlobUrls`, `heapMB`, `rebuffers`, `stallMs`,
  `loopGapMaxMs`/`longTaskMaxMs` (main-thread blocking)

## Pack player (Drive-safe path)

Pack frames are fetched as multi-frame chunks (`packs/<slug>/chunks/c####.bin`,
20 JPEGs = 2s per request; byte lengths in `manifest.json`). The fetch window is
anchored at the playhead and sized from measured p95 load time (4–20s); requests
that fall behind are aborted. Only ~6 frames are decoded at a time (Image + blob
URL), and everything behind the playhead is released. The picture follows the
`AudioContext` clock; if it underruns, audio pauses briefly (rebuffer) instead
of drifting. `?chunks=0` forces the old one-request-per-frame mode.

Console: CloudWatch → Logs → Insights → select the saved query.
Car tip: open `?pack=1` or tap **Force pack fallback** first; WebCodecs may probe green but stall.

## Cloudflare hosting (primary): https://<your-deployment>

Everything is served same-origin by one Cloudflare Worker, `tesla-client-decode-poc` — nothing on AWS:

| Path | Served by |
| --- | --- |
| `/`, `/app.js`, `/catalog.json`, `/vendor/*` | Workers Static Assets |
| `/packs/<slug>/manifest.json`, `chunks/*.bin`, `frames/*.jpg`, `audio.pcm` | Workers Static Assets (cached 1 day) |
| `/videos/<slug>.mp4` | Worker → Static Assets, with byte-range support (`206`/`416`) |
| `POST /api/logs` | Worker → Workers Logs (one structured JSON entry per browser log line) |

Files: `cloudflare/wrangler.jsonc`, `cloudflare/src/worker.js`, `cloudflare/build.sh`.

```bash
# needs local media/*.mp4 and packs/<slug>/ (see tools/build_chunks.py)
npx wrangler login            # once
cloudflare/build.sh deploy    # builds cloudflare/dist and runs wrangler deploy
```

`<your-deployment>` is a Worker **Custom Domain** (Cloudflare creates the DNS record and certificate). No other record or Worker on the zone is touched.

### Reading car logs
* Dashboard: **Workers & Pages → tesla-client-decode-poc → Observability → Logs**. Filter `sessionId = <id shown on the page>`; useful filters: `event = heartbeat`, `event = pack_fallback`, `level = error`.
* Live: `cd cloudflare && npx wrangler tail tesla-client-decode-poc --format pretty --search <sessionId>`

Each entry carries the original fields (`ts`, `level`, `event`, `msg`, `sessionId`, …) plus `source`, `colo`, `country`, `ua`.
