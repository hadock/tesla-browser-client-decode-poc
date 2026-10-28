# Security policy

This repository is a **responsible-disclosure proof of concept** for a
Tesla in-car browser safety-control gap. It is private and intended only
for the reporter and Tesla / Bugcrowd reviewers.

## Reporting

Do **not** open a public issue. Contact the reporter via the Bugcrowd
submission associated with this finding, or email `you@example.com`
(placeholder — replace with the reporter's Bugcrowd contact).

## Scope of this PoC

- Demonstrates client-side decode of an MP4 into JPEG `<img>` frames +
  Web Audio PCM, with no visible `<video>` element.
- Static site only (S3 + CloudFront). No user accounts, no PII collected.
- Source media is CC BY 3.0; attribution is displayed.

## What this is not

- Not a consumer product, streaming service, or media player.
- Not an exploit chain, RCE, or credential theft tool.
- Not licensed for redistribution as a general-purpose player.
