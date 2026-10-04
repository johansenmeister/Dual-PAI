#!/usr/bin/env python3
"""
Fill missing ALBUM tags from folder names for Navidrome. v5.

PROBLEM: After setting PID.Album=albumartistid,album, every track with an EMPTY
album tag collapses into one giant "[Unknown Album]" per album-artist (e.g. all
727 tracks across many The Prodigy folders merged into one album).

FIX: Derive a sensible album name from each track's folder and write the ALBUM
tag (only where currently empty). Tracks in the same folder get the same album →
they group correctly instead of merging into [Unknown Album].

INPUT: a file with one container-relative path per line (from Navidrome DB:
  SELECT path FROM media_file WHERE missing=0 AND (album='' OR album='[Unknown Album]');
Container paths look like "The Prodigy/1991 02 What Evil Lurks/track.mp3" and map
to  {MOUNT}/The Prodigy/1991 02 What Evil Lurks/track.mp3

DERIVATION RULES:
  - disc subfolder (CD 1, Disc 2, cd3)      -> use parent folder name
  - year-only folder (1983)                 -> "{parent} {year}"
  - "YYYY NN Name"  (1991 02 What Evil Lurks)-> "Name"
  - "YYYY - Name" / "YYYY Name"             -> "Name"
  - otherwise                                -> folder basename as-is

Usage:
  python3 fill_album_from_folder.py paths.txt --dry-run
  sudo python3 fill_album_from_folder.py paths.txt
"""
import os
import re
import sys

MOUNT = "/mnt/Audio/Album"

def is_disc_folder(name):
    return bool(re.match(r'^(cd|disc|disk)[\s_-]*\d+$', name.strip(), re.IGNORECASE))

def derive_album(container_path):
    folder = os.path.dirname(container_path)
    base = os.path.basename(folder)
    parent = os.path.basename(os.path.dirname(folder))

    # Disc subfolder -> use parent as the album
    if is_disc_folder(base):
        return parent.strip() if parent else base.strip()

    # Year-only folder -> "{parent} {year}"
    if re.match(r'^\d{4}$', base):
        return f"{parent} {base}".strip() if parent else base

    b = base
    # "YYYY NN Name" (year + 2-digit track, space-separated, no dash)
    b = re.sub(r'^\d{4}\s+\d{2}\s+', '', b)
    # "YYYY - Name"
    b = re.sub(r'^\d{4}\s*[-–]\s*', '', b)
    # "YYYY Name" (year then a letter)
    b = re.sub(r'^\d{4}\s+(?=[A-Za-zÆØÅæøå])', '', b)
    return b.strip()

def get_audio(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.mp3':
        from mutagen.mp3 import EasyMP3
        return EasyMP3(path)
    elif ext == '.flac':
        from mutagen.flac import FLAC
        return FLAC(path)
    elif ext == '.m4a':
        from mutagen.easymp4 import EasyMP4
        return EasyMP4(path)
    return None

def main():
    if len(sys.argv) < 2:
        print("Usage: fill_album_from_folder.py paths.txt [--dry-run]")
        sys.exit(1)
    paths_file = sys.argv[1]
    dry = "--dry-run" in sys.argv

    container_paths = [l.strip() for l in open(paths_file) if l.strip()]
    print(f"Input paths: {len(container_paths)} | DRY RUN: {dry}\n")

    applied, skipped, failed = 0, 0, []
    for cp in container_paths:
        real = os.path.join(MOUNT, cp)
        album = derive_album(cp)
        if not album or len(album) < 1:
            failed.append((cp, "empty derived album"))
            continue
        try:
            audio = get_audio(real)
            if audio is None:
                failed.append((cp, "unsupported"))
                continue
            current = (audio.get('album') or [None])[0]
            if current:  # already has an album — don't overwrite
                skipped += 1
                continue
            if not dry:
                audio['album'] = [album]
                audio.save()
            applied += 1
            if applied <= 25:
                print(f"  {'[DRY] ' if dry else ''}{os.path.basename(cp)}  →  album='{album}'")
        except Exception as e:
            failed.append((cp, str(e)))

    print(f"\nApplied: {applied} | Skipped(has album): {skipped} | Failed: {len(failed)}")
    if failed:
        print("Failures (first 15):")
        for cp, err in failed[:15]:
            print(f"  {cp}: {err}")

if __name__ == '__main__':
    main()
