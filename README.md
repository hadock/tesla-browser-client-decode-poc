# Tesla Browser — Client Decode PoC

> **Disclaimer.** This is a proof of concept for **security research and
> testing only**. It is **not for use while driving**: test with the vehicle
> parked, or with a passenger operating the browser and filming. It is
> provided **as-is, without warranty of any kind**. Responsibility for any
> use lies entirely with the person who deploys or uses it. See
> [LICENSE](LICENSE) and [DISCLOSURE.md](DISCLOSURE.md).

**Responsible disclosure only.** Companion to the server-streamed variant,
[`tesla-browser-media-bypass-poc`](https://github.com/hadock/tesla-browser-media-bypass-poc).

This PoC shows the Drive-mode media-playback gap **entirely in the browser**:
the page renders JPEG frames into an `<img>` while playing PCM through the
Web Audio API. By default no `<video>` element is ever created (the hidden
`<video>` decode path only exists behind `?allowVideo=1`).

## Why this exists

Tesla's in-car browser blocks HTML5 `<video>` (and equivalent media
elements) while the vehicle is in Drive. That control does **not** extend to:

1. Rapidly swapping the `src` of an `<img>` with sequential JPEG frames
   (or redrawing a `<canvas>`), and
2. Playing PCM audio through the Web Audio API.

The sibling PoC streams frames over WSS from Lambda. This one needs **only a
static host**: playback and decoding are fully client-side. Nothing on the
server touches the media.

**What runs where**

| Piece | Role | Needed? |
|---|---|---|
| Static files (SPA, `/packs`, `/videos`) | everything playback needs | **yes** |
| Image packs (`/packs/<slug>/`, chunked) | default player — **the one that works in the car** | yes |
| MP4s (`/videos/<slug>.mp4`, not chunked) | only the opt-in WebCodecs path (`?wc=1`), which stalls in the Tesla browser | optional |
| `POST /api/logs` (AWS: API Gateway + Lambda → CloudWatch; Cloudflare: Worker → Workers Logs) | **debug logs only** — never serves or processes media | optional, `ENABLE_LOGS=1` |

The minimal AWS deploy is just **S3 + CloudFront** (`ENABLE_LOGS=0`, the
default). On Cloudflare the Worker always runs (it adds byte-range support for
`/videos`); with `ENABLE_LOGS=0` the page simply never posts to `/api/logs`.

## Architecture

```
Static host (Cloudflare Worker + Static Assets, or AWS CloudFront + S3)
  /                       SPA (index.html, app.js, styles.css, catalog.json)
  /packs/<slug>/...       JPEG frame packs (20-frame chunks) + PCM audio   ← default player (works in the car)
  /videos/<slug>.mp4      H.264/AAC source clips, not chunked              ← opt-in WebCodecs path (?wc=1)
  POST /api/logs          OPTIONAL (ENABLE_LOGS=1): browser debug logs only
                          → Workers Logs | Lambda → CloudWatch Logs
         │ same-origin (no CORS)
         ▼
Browser (Tesla in-car / desktop)
  Default:  pack player → <img> + Web Audio (audio clock drives the picture)
  Opt-in:   ?wc=1 WebCodecs VideoDecoder → canvas → JPEG <img>
  All fetching, decoding, timing and rendering happen here, in the browser.
```

## Live Streaming tab

A second tab, **Live Streaming**, extends the same finding to **live HLS**:
fetch a master/media playlist, demux segments client-side (MPEG-TS via
vendored [mux.js](https://github.com/videojs/mux.js), or fMP4 via MP4Box),
decode with WebCodecs, draw to a canvas, JPEG into an `<img>`, and play audio
through Web Audio — still **zero** `<video>` / `<audio>` elements.

The list is **fixed** to public player-test / CC-licensed demo feeds only
(no TV channels, no IPTV directory, no user-supplied M3U/URL, no proxy).
Media stays on the third-party CDN; nothing is rehosted:

| Stream | Kind | Source / license | URL |
|--------|------|------------------|-----|
| Unified Streaming live | **Live** MPEG-TS | [Unified Streaming](https://docs.unified-streaming.com/) public live demo | `https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8` |
| Mux · Big Buck Bunny | VOD MPEG-TS | [Mux test-streams](https://test-streams.mux.dev/); film © Blender Foundation (**CC BY**) | `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` |
| Tears of Steel | VOD MPEG-TS | Unified Streaming demo; film © Blender Foundation (**CC BY**) | `https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8` |
| Apple HLS example (fMP4) | VOD fMP4 | Official [Apple HLS example](https://developer.apple.com/streaming/examples/) | `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8` |

Open with `?tab=live`. On-screen **Live diagnostics** show WebCodecs support,
frames decoded/shown/late/dropped, ready queue, audio buffered/queued/underruns/last-gap, A/V drift (ms), buffer, and errors. Picture is hold-don't-skip; audio is gapless and prioritized over video decode so muxed AAC is never discarded under JPEG backpressure.
Picture is locked to the `AudioContext` clock at 1× (late frames are dropped,
not sped up); audio is scheduled gapless so TS PTS discontinuities do not
starve the graph. Live HLS **requires WebCodecs**;
that path previously stalled in the Tesla browser — the banner and diagnostics
are there to capture exactly where it fails in the car. The Clips tab (JPEG
packs) remains the path that works in Drive mode. Remote logging of these
diagnostics uses the same optional `/api/logs` path (`ENABLE_LOGS=1` only).

Same safety disclaimer as the rest of the PoC: testing only, vehicle parked
or a passenger filming — never while driving. Upstream feeds can go away or
return empty media playlists; the player surfaces that as an error rather than
falling back to a proxy.

## Hosted clips (CC BY 3.0 — not MIT)

| Slug | Artist — Title | Segment |
|------|----------------|---------|
| `patricia` | Patricia Janečková — La Danza (Rossini) | 50–120s |
| `rickastley` | Rick Astley — Never Gonna Give You Up (live) | 45–115s |
| `spencerx` | Spencer X — Be Somebody (beatbox) | 15–85s |
| `decadentes` | Los Auténticos Decadentes — Yo No Soy Tu Prisionero (live) | 30–100s |

The media clips (and the frame packs / PCM derived from them) are licensed
under their own **Creative Commons Attribution 3.0** licenses
(https://creativecommons.org/licenses/by/3.0/), **not** under the MIT license
that covers this repository's code. Per-clip attribution, license URL and
source are in `frontend/catalog.json` and shown under the player. Keep that
attribution if you redistribute them.

## Deploy (choose the target at deploy time)

One script, two targets. Nothing account-specific is committed: account,
domain, stack/worker names and log destinations come from env vars, flags, or
an untracked env file (`.deploy.env.local`, gitignored — see
`.deploy.env.example`).

```bash
./deploy.sh --help
./deploy.sh cloudflare [all|build|config|dry-run] [--worker-name N] [--custom-domain HOST] [--account-id ID] [--enable-logs|--no-logs]
./deploy.sh aws [all|stack|frontend|videos|packs|lambda|queries|invalidate|validate|dry-run] \
               [--stack N] [--region R] [--profile P] [--log-group G] [--bucket-prefix X] [--expected-account ID] [--enable-logs|--no-logs]
TARGET=cloudflare ./deploy.sh          # same thing via env
```

| Variable | Default | Notes |
|---|---|---|
| `ENABLE_LOGS` | `0` | `1` = the page posts debug logs to `/api/logs` (AWS also creates the HTTP API + Lambda + log group). `0` = no remote logging; logs stay in the browser console and the on-page Debug panel. Playback is identical either way. |

Prerequisites: local `media/*.mp4` and `packs/<slug>/` — build each pack from
its mp4 with `tools/build_packs.py` (see [Building packs](#building-image-packs-from-an-mp4)).
Both folders are gitignored.

### Cloudflare (recommended: no AWS resources)

| Variable | Default | Notes |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | — | Optional. Otherwise the account from `npx wrangler login` (or `CLOUDFLARE_API_TOKEN`). |
| `WORKER_NAME` | `tesla-client-decode-poc` | Worker script name. |
| `CUSTOM_DOMAIN` | — | Optional, e.g. `poc.example.com` (zone must be on the same account). Unset → `https://<WORKER_NAME>.<your-subdomain>.workers.dev`. |

`cloudflare/wrangler.jsonc` is **generated** from the committed
`cloudflare/wrangler.template.jsonc` on every deploy and is gitignored.
A custom domain is attached as a Worker Custom Domain: Cloudflare creates that
one DNS record and certificate; no other record is touched.

| Path | Served by |
| --- | --- |
| `/`, `/app.js`, `/catalog.json`, `/vendor/*`, `/packs/**` | Workers Static Assets |
| `/videos/<slug>.mp4` | Worker → Static Assets, with byte-range support (`206`/`416`) |
| `POST /api/logs` | Worker → Workers Logs (one structured JSON entry per browser log line). Only called when deployed with `ENABLE_LOGS=1`. |

Reading logs (`ENABLE_LOGS=1`): Dashboard → **Workers & Pages → `<WORKER_NAME>` → Observability → Logs**,
filter `sessionId = <id shown in the page's Debug panel>`; or live:
`cd cloudflare && npx wrangler tail <WORKER_NAME> --format pretty --search <sessionId>`.

### AWS (S3 + CloudFront; optional log Lambda)

With the default `ENABLE_LOGS=0` the CloudFormation stack is only **S3 +
CloudFront (OAC)** — 4 resources, no API Gateway, no Lambda, no log group.
With `ENABLE_LOGS=1` the template's `LogsEnabled` condition adds the
debug-log endpoint: HTTP API + Lambda (`backend/logs/handler.py`, which only
writes the posted log lines to CloudWatch) + log group + the CloudFront
`/api/*` behavior, plus saved Logs Insights queries. Switching an existing
stack from 1 to 0 deletes those log resources (and the log group).

| Variable | Default | Notes |
|---|---|---|
| `ENABLE_LOGS` | `0` | See above. `lambda` / `queries` modes require `1`. |
| `AWS_PROFILE` / `AWS_REGION` | standard AWS chain / `us-east-1` | Any standard AWS credential source works. |
| `STACK_NAME` | `tesla-browser-client-decode-poc` | CloudFormation stack and resource name prefix. |
| `LOG_GROUP_NAME` | `/<STACK_NAME>/browser` | CloudWatch log group for browser logs (`ENABLE_LOGS=1` only). |
| `BUCKET_PREFIX` | — | Optional; bucket becomes `<prefix>-<STACK_NAME>`. Unset → CloudFormation-generated name. |
| `EXPECTED_AWS_ACCOUNT` | — | Optional safety guard: refuse to deploy to any other account. |
| `QUERY_PREFIX` | `tesla-client-decode` | Name prefix for the saved Logs Insights queries (`ENABLE_LOGS=1` only). |

`./deploy.sh aws validate` only validates the template; `./deploy.sh aws dry-run`
creates a CloudFormation change set without executing it. Saved query IDs and
the generated `config.js` are written to `.deploy/` (gitignored). The site URL
is the CloudFront domain printed at the end (`https://<your-deployment>`).

Saved Logs Insights queries (`ENABLE_LOGS=1` only): `<prefix>-car-failures` (timeouts, decoder
errors, pack fallbacks, errors), `<prefix>-session` (paste a `sessionId`),
`<prefix>-heartbeat` (pack-player trend: `lagMs`, `bufAheadMs`,
`loadP50`/`loadP95`, `kbps`, `inflight`, `liveImgs`, `heapMB`, `rebuffers`,
`stallMs`, `loopGapMaxMs`/`longTaskMaxMs`).

## Try it

1. Open `https://<your-deployment>/`.
2. Tap a clip in the playlist (tap the player to pause / resume). **Play all**
   auto-advances. `?pack=1` autostarts the pack player.
3. Open **Debug** under the player: the HUD shows `Renderer: JPEG pack → <img>`,
   `<video> in DOM: 0`, and the session id used in the logs.
4. In the car — **parked, or with a passenger filming**: baseline a normal
   `<video>` page first, then load the PoC and shift to Drive.

## Local smoke test

```bash
cd frontend
ln -sfn ../media videos && ln -sfn ../packs packs
python3 -m http.server 8080      # http://127.0.0.1:8080/
```

The committed `frontend/config.js` has `logsEnabled: false`, so the local page
never posts logs. Deploys write their own `config.js` from `ENABLE_LOGS`;
`?logs=0` turns remote logging off for a single visit.

## Building image packs from an mp4

The car plays **image packs**, not the mp4s. Build one per clip:

```bash
python3 tools/build_packs.py media/myclip.mp4 myclip                  # whole file
python3 tools/build_packs.py source.webm myclip --start 50 --duration 70   # trim
python3 tools/build_packs.py media/myclip.mp4 myclip --force          # rebuild
```

It runs ffmpeg and writes `packs/<slug>/` in exactly the format the player
expects: `frames/000000.jpg…` (10 fps, 480 px wide, mjpeg `-q:v 5`),
`audio.pcm` (s16le, mono, 24 kHz; silence if the input has no audio track),
`manifest.json`, then bundles the frames into `chunks/c####.bin` (20 JPEGs
each, byte lengths in the manifest) via `tools/build_chunks.py`. Options:
`--fps`, `--width`, `--jpeg-q`, `--audio-rate`, `--chunk-frames`,
`--packs-dir`. Needs `ffmpeg` and `ffprobe` on PATH. A 70 s clip builds in a
couple of seconds and is ~23 MB (~10 MB of chunks).

Then add an entry to `frontend/catalog.json` (`slug`, `title`, `pack:
"/packs/<slug>/manifest.json"`, `src: "/videos/<slug>.mp4"`, license and
attribution) and redeploy. Keep each clip's mp4 in `media/` only if you want the
`?wc=1` WebCodecs path for it; the pack player does not use it. The playlist
thumbnail is the pack's middle frame. `python3 tools/build_chunks.py [packs_dir] [frames] [slug…]`
re-chunks existing packs.

## Pack player (Drive-safe path)

Pack frames are fetched as multi-frame chunks (`packs/<slug>/chunks/c####.bin`,
20 JPEGs = 2s per request; byte lengths in `manifest.json`). The fetch window is
anchored at the playhead and sized from measured p95 load time (4–20s); requests
that fall behind are aborted. Only ~6 frames are decoded at a time (Image + blob
URL), and everything behind the playhead is released. The picture follows the
`AudioContext` clock; if it underruns, audio pauses briefly (rebuffer) instead
of drifting. `?chunks=0` forces one request per frame.

## Repo layout

```
deploy.sh                    single entry point: ./deploy.sh <aws|cloudflare>
scripts/deploy-aws.sh        AWS target (CloudFormation S3 + CloudFront; + log Lambda/queries if ENABLE_LOGS=1)
scripts/deploy-cloudflare.sh Cloudflare target (build dist + generate wrangler config + deploy)
cloudflare/                  Worker (src/worker.js) + wrangler.template.jsonc
infra/template.yaml          CloudFormation: S3 + CloudFront OAC; HTTP API + Lambda + log group only if EnableLogs=true
backend/logs/handler.py      optional log Lambda: POST /api/logs → CloudWatch Logs (debug logs only, no media)
frontend/                    SPA (index.html, app.js, live.js, styles.css, catalog.json, vendor/mp4box+mux.js)
tools/                       build_packs.py (mp4 → frame pack), build_chunks.py (re-chunk), gen_wrangler.py
media/, packs/               local source clips and frame packs (gitignored)
```

## License

Code: [MIT](LICENSE), Copyright (c) 2026 Sergio Barraza. The media clips and
derived packs are **not** MIT — they remain under their CC BY 3.0 licenses
(see above). `frontend/vendor/mp4box.all.min.js` is MP4Box.js (BSD-3-Clause); `frontend/vendor/mux.min.js` is mux.js (Apache-2.0).

## Security / disclosure

See `DISCLOSURE.md` and `SECURITY.md`. Intentional, minimal, not a consumer
product.
