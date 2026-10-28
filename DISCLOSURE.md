# Responsible disclosure: Tesla in-car browser media-playback bypass (client-side decode)

**Reporter:** Sergio Barraza
**Target:** Tesla vehicle in-car web browser (infotainment)
**Program:** Tesla Bugcrowd (https://bugcrowd.com/tesla)
**Classification:** Safety-control bypass / policy enforcement gap
**PoC repository:** https://github.com/hadock/tesla-browser-client-decode-poc (private — invite Tesla/Bugcrowd only)
**Sibling PoC (server-streamed frames):** https://github.com/hadock/tesla-browser-media-bypass-poc
**Status:** Ready for submission — PoC is intentional, minimal, and not a consumer product

---

## Summary

The Tesla in-car browser blocks HTML5 `<video>` (and equivalent media-element)
playback while the vehicle is in Drive. That control does **not** extend to:

1. Rapidly swapping the `src` of an `<img>` element (or redrawing a `<canvas>`)
   with sequential JPEG frames, and
2. Playing PCM (or other) audio through the Web Audio API.

This repository is a short, self-contained proof that the gap can be exploited
**entirely client-side**: the page loads an MP4 from the same origin, decodes
it in the browser (WebCodecs when available, otherwise a hidden `<video>`
drawn to canvas), and presents the result as JPEG frames in an `<img>` plus
Web Audio PCM. No `<video>` element is ever shown to the user. No Lambda /
WebSocket streamer is required.

## Impact

- A driver (or a page the driver opens) can watch moving imagery with sound
  while the car is in Drive, defeating the distraction mitigation the
  `<video>` block is meant to provide.
- Any site the browser can reach can implement the same pattern; the PoC is
  not special-cased to one origin.
- Severity is a **safety-policy bypass**, not a memory-corruption RCE. Still
  in scope for a vehicle program because it undermines a driver-distraction
  control.

## Environment observed

- Tesla in-car web browser, vehicle in **Drive**
- `<video>` / media-element playback refused or inert
- `<img>` animation via `src` reassignment: allowed
- Canvas 2D `drawImage` of stills: allowed
- Web Audio API (`AudioContext`, `decodeAudioData`, `AudioBufferSourceNode`): allowed
- `fetch()` of same-origin MP4 + `canvas.toBlob('image/jpeg')`: allowed

Exact software / firmware build should be filled in by the reporter at
submission time (Controls → Software).

## Reproduction

1. Park. Open a normal HTML5 video page in the in-car browser; confirm it
   does **not** play in Drive (control baseline).
2. Open the hosted PoC URL (CloudFront distribution from this repo).
3. Pick a hosted clip → **Play**.
4. Shift to **Drive**. Observe: frames advance in the `<img>`, audio is
   audible, lips/instruments stay aligned. The HUD reports
   `Renderer: … JPEG <img> (not <video>)`. View-source / DevTools (if
   available) confirms no visible `<video>`.

Desktop sanity check: `cd frontend && ln -sfn ../media videos && python3 -m http.server 8080`,
then open `http://127.0.0.1:8080/`.

## Suggested fix

Extend the Drive-mode media policy to cover:

- High-frequency `<img>` `src` reassignment / `<canvas>` redraws that
  approximate video frame rates, and/or
- Web Audio playback concurrent with rapid visual updates,

or gate the combination behind the same Park/Drive check that already
disables `<video>`.

## Out of scope / non-goals

- No attempt to bypass authentication, DRM, or network controls.
- No persistence, no autofill of credentials, no phishing.
- Source clips are CC BY 3.0 performance footage used solely to demonstrate
  lip/instrument sync; attribution is shown in the UI.
