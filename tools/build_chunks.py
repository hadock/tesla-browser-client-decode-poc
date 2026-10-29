#!/usr/bin/env python3
"""Bundle pack JPEG frames into multi-frame chunks (cuts ~700 requests/clip to ~35).

packs/<slug>/chunks/c0000.bin = concatenated JPEGs; byte lengths go in manifest.json:
  "chunk_frames": 20,
  "chunks": [{"file": "c0000.bin", "first": 0, "lengths": [..]}, ...],
  "chunks_prefix": "/packs/<slug>/chunks/"
Per-frame files stay in place (older clients / ?chunks=0 still work).
tools/build_packs.py calls chunk_pack() for you; run this directly to re-chunk.
Usage: tools/build_chunks.py [packs_dir] [frames_per_chunk] [slug ...]
"""
import json, sys
from pathlib import Path


def chunk_pack(slug_dir: Path, per: int = 20) -> dict:
    """(Re)build slug_dir/chunks/*.bin and the chunk index in slug_dir/manifest.json."""
    mpath = slug_dir / "manifest.json"
    m = json.loads(mpath.read_text())
    frames = m["frames"]
    out = slug_dir / "chunks"
    out.mkdir(exist_ok=True)
    for old in out.glob("c*.bin"):
        old.unlink()
    chunks = []
    for ci, start in enumerate(range(0, len(frames), per)):
        names = frames[start:start + per]
        blobs = [(slug_dir / "frames" / n).read_bytes() for n in names]
        for b in blobs:
            assert b[:2] == b"\xff\xd8", f"not a JPEG in {slug_dir.name}"
        fn = f"c{ci:04d}.bin"
        (out / fn).write_bytes(b"".join(blobs))
        chunks.append({"file": fn, "first": start, "lengths": [len(b) for b in blobs]})
    m["chunk_frames"] = per
    m["chunks_prefix"] = f"/packs/{slug_dir.name}/chunks/"
    m["chunks"] = chunks
    mpath.write_text(json.dumps(m, separators=(",", ":")))
    total = sum(sum(c["lengths"]) for c in chunks)
    print(f"{slug_dir.name}: {len(frames)} frames -> {len(chunks)} chunks, {total/1e6:.1f} MB, "
          f"avg {total/max(len(chunks), 1)/1e3:.0f} KB/chunk")
    return m


def main(argv):
    root = Path(argv[1] if len(argv) > 1 else Path(__file__).resolve().parent.parent / "packs")
    per = int(argv[2]) if len(argv) > 2 else 20
    only = set(argv[3:])
    for slug_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        if only and slug_dir.name not in only:
            continue
        if not (slug_dir / "manifest.json").is_file():
            continue
        chunk_pack(slug_dir, per)


if __name__ == "__main__":
    main(sys.argv)
