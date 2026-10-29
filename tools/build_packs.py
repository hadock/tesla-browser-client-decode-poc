#!/usr/bin/env python3
"""Build a complete frame pack (the Drive-safe player's input) from an mp4.

  python3 tools/build_packs.py media/myclip.mp4 myclip
  python3 tools/build_packs.py input.webm myclip --start 50 --duration 70

Writes packs/<slug>/ in the format frontend/app.js and tools/build_chunks.py use:
  frames/000000.jpg ...     480px-wide JPEGs at 10 fps (ffmpeg mjpeg, -q:v 5)
  audio.pcm                 raw PCM s16le, mono, 24 kHz (silence if the input has no audio)
  manifest.json             fps, frames[], audio_* fields, chunk index
  chunks/c0000.bin ...      20 JPEGs per file (via build_chunks.chunk_pack)

Then add a clip entry to frontend/catalog.json ("slug", "title", "pack":
"/packs/<slug>/manifest.json", "src": "/videos/<slug>.mp4", license/attribution)
and redeploy. Requires ffmpeg + ffprobe on PATH.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_chunks import chunk_pack  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LABEL = "pack fallback (pre-extracted JPEG + PCM — no <video>, not live decode)"


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def has_audio(path: Path) -> bool:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
         "-of", "csv=p=0", str(path)], text=True)
    return bool(out.strip())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path, help="source video (mp4, or anything ffmpeg reads)")
    ap.add_argument("slug", help="pack name: lowercase letters, digits, - or _ (URL path /packs/<slug>/)")
    ap.add_argument("--packs-dir", type=Path, default=ROOT / "packs", help="output root (default: ./packs)")
    ap.add_argument("--start", type=float, default=None, help="trim: start offset in seconds")
    ap.add_argument("--duration", type=float, default=None, help="trim: length in seconds")
    ap.add_argument("--fps", type=int, default=10, help="frame rate (default 10; the player is tuned for 10)")
    ap.add_argument("--width", type=int, default=480, help="frame width, height keeps aspect (default 480)")
    ap.add_argument("--jpeg-q", type=int, default=5, help="ffmpeg mjpeg -q:v 2-31, lower = better/larger (default 5)")
    ap.add_argument("--audio-rate", type=int, default=24000, help="PCM sample rate (default 24000)")
    ap.add_argument("--chunk-frames", type=int, default=20, help="JPEGs per chunk file (default 20 = 2 s)")
    ap.add_argument("--force", action="store_true", help="replace an existing packs/<slug>/")
    a = ap.parse_args()

    import re
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", a.slug):
        ap.error("slug must match [a-z0-9][a-z0-9_-]{0,63}")
    if not a.input.is_file():
        ap.error(f"input not found: {a.input}")
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            print(f"error: {tool} not found on PATH", file=sys.stderr)
            return 1

    dest = a.packs_dir / a.slug
    if dest.exists() or dest.is_symlink():
        if not a.force:
            print(f"error: {dest} exists (use --force to replace it)", file=sys.stderr)
            return 1
    a.packs_dir.mkdir(parents=True, exist_ok=True)

    trim: list[str] = []
    if a.start is not None:
        trim += ["-ss", f"{a.start:g}"]
    if a.duration is not None:
        trim += ["-t", f"{a.duration:g}"]
    ff = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]

    # Build in a temp dir next to the destination, then swap in (no half-written pack).
    work = Path(tempfile.mkdtemp(prefix=f".{a.slug}-", dir=a.packs_dir))
    try:
        frames_dir = work / "frames"
        frames_dir.mkdir()
        run(ff + trim + ["-i", str(a.input), "-an",
                         "-vf", f"fps={a.fps},scale={a.width}:-2",
                         "-q:v", str(a.jpeg_q), "-start_number", "0",
                         str(frames_dir / "%06d.jpg")])
        frames = sorted(p.name for p in frames_dir.glob("*.jpg"))
        if not frames:
            print("error: ffmpeg produced no frames", file=sys.stderr)
            return 1

        pcm = work / "audio.pcm"
        if has_audio(a.input):
            run(ff + trim + ["-i", str(a.input), "-vn", "-ac", "1", "-ar", str(a.audio_rate),
                             "-f", "s16le", "-acodec", "pcm_s16le", str(pcm)])
        else:
            secs = len(frames) / a.fps
            print(f"(no audio stream: writing {secs:.1f}s of silence)")
            pcm.write_bytes(b"\x00\x00" * int(round(secs * a.audio_rate)))

        manifest = {
            "slug": a.slug,
            "fps": a.fps,
            "frame_count": len(frames),
            "frames_prefix": f"/packs/{a.slug}/frames/",
            "frame_pattern": "frame_{i:04d}.jpg",  # legacy field kept for format parity; frames[] is authoritative
            "frames": frames,
            "audio": f"/packs/{a.slug}/audio.pcm",
            "audio_sample_rate": a.audio_rate,
            "audio_channels": 1,
            "audio_format": "s16le",
            "label": LABEL,
            "first_frame": frames[0],
            "last_frame": frames[-1],
            "bytes_per_sample": 2,
        }
        (work / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))

        if dest.is_symlink() or dest.is_file():
            dest.unlink()
        elif dest.exists():
            shutil.rmtree(dest)
        work.rename(dest)
    finally:
        if work.exists():
            shutil.rmtree(work, ignore_errors=True)

    m = chunk_pack(dest, a.chunk_frames)
    audio_s = (dest / "audio.pcm").stat().st_size / (2 * a.audio_rate)
    size = sum(p.stat().st_size for p in dest.rglob("*") if p.is_file())
    print(f"pack {a.slug}: {m['frame_count']} frames @ {a.fps} fps ({m['frame_count']/a.fps:.1f}s), "
          f"audio {audio_s:.1f}s, {len(m['chunks'])} chunks, {size/1e6:.1f} MB -> {dest}")
    print("next: add it to frontend/catalog.json, e.g.")
    print(json.dumps({"slug": a.slug, "title": a.slug, "src": f"/videos/{a.slug}.mp4",
                      "pack": f"/packs/{a.slug}/manifest.json",
                      "license": "<license>", "attribution": "<attribution>"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
