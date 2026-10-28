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

The sibling PoC streams frames over WSS from Lambda. This one needs only a
static host plus an optional log endpoint.

## Architecture

```
Static host (Cloudflare Worker + Static Assets, or AWS CloudFront + S3)
  /                       SPA (index.html, app.js, styles.css, catalog.json)
  /packs/<slug>/...       JPEG frame packs (20-frame chunks) + PCM audio   ← default player
  /videos/<slug>.mp4      H.264/AAC source clips (byte-range capable)      ← WebCodecs path
  POST /api/logs          browser debug logs → Workers Logs | CloudWatch Logs
         │ same-origin (no CORS)
         ▼
Browser (Tesla in-car / desktop)
  Default:  pack player → <img> + Web Audio (audio clock drives the picture)
  Optional: WebCodecs VideoDecoder → canvas → JPEG <img>
```

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
./deploy.sh cloudflare [all|build|config|dry-run] [--worker-name N] [--custom-domain HOST] [--account-id ID]
./deploy.sh aws [all|stack|frontend|videos|packs|lambda|queries|invalidate|validate|dry-run] \
               [--stack N] [--region R] [--profile P] [--log-group G] [--bucket-prefix X] [--expected-account ID]
TARGET=cloudflare ./deploy.sh          # same thing via env
```

Prerequisites: local `media/*.mp4` and `packs/<slug>/` (build chunks with
`python3 tools/build_chunks.py`). Both are gitignored.

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
| `POST /api/logs` | Worker → Workers Logs (one structured JSON entry per browser log line) |

Reading logs: Dashboard → **Workers & Pages → `<WORKER_NAME>` → Observability → Logs**,
filter `sessionId = <id shown in the page's Debug panel>`; or live:
`cd cloudflare && npx wrangler tail <WORKER_NAME> --format pretty --search <sessionId>`.

### AWS (CloudFront + S3 + API Gateway + Lambda + CloudWatch)

| Variable | Default | Notes |
|---|---|---|
| `AWS_PROFILE` / `AWS_REGION` | standard AWS chain / `us-east-1` | Any standard AWS credential source works. |
| `STACK_NAME` | `tesla-browser-client-decode-poc` | CloudFormation stack and resource name prefix. |
| `LOG_GROUP_NAME` | `/<STACK_NAME>/browser` | CloudWatch log group for browser logs. |
| `BUCKET_PREFIX` | — | Optional; bucket becomes `<prefix>-<STACK_NAME>`. Unset → CloudFormation-generated name. |
| `EXPECTED_AWS_ACCOUNT` | — | Optional safety guard: refuse to deploy to any other account. |
| `QUERY_PREFIX` | `tesla-client-decode` | Name prefix for the saved Logs Insights queries. |

`./deploy.sh aws validate` only validates the template; `./deploy.sh aws dry-run`
creates a CloudFormation change set without executing it. Saved query IDs and
the generated `config.js` are written to `.deploy/` (gitignored). The site URL
is the CloudFront domain printed at the end (`https://<your-deployment>`).

Saved Logs Insights queries: `<prefix>-car-failures` (timeouts, decoder
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
python3 -m http.server 8080      # http://127.0.0.1:8080/  (POST /api/logs will 501 locally)
```

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
scripts/deploy-aws.sh        AWS target (CloudFormation + S3 + Lambda + Insights queries)
scripts/deploy-cloudflare.sh Cloudflare target (build dist + generate wrangler config + deploy)
cloudflare/                  Worker (src/worker.js) + wrangler.template.jsonc
infra/template.yaml          CloudFormation (S3 + CloudFront OAC + HTTP API + Lambda + log group)
backend/logs/handler.py      Lambda: POST /api/logs → CloudWatch Logs
frontend/                    SPA (index.html, app.js, styles.css, catalog.json, vendor/mp4box)
tools/                       build_chunks.py (frame packs), gen_wrangler.py
media/, packs/               local source clips and frame packs (gitignored)
```

## License

Code: [MIT](LICENSE), Copyright (c) 2026 Sergio Barraza. The media clips and
derived packs are **not** MIT — they remain under their CC BY 3.0 licenses
(see above). `frontend/vendor/mp4box.all.min.js` is MP4Box.js (BSD-3-Clause).

## Security / disclosure

See `DISCLOSURE.md` and `SECURITY.md`. Intentional, minimal, not a consumer
product.
