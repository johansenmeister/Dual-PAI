#!/usr/bin/env python3
"""
Fix De Lillos tracks with completely missing tags. These files have no ID3 data
at all, so mutagen.MP3 (not EasyMP3) must be used to add fresh tags.

Strategy: Extract metadata from directory structure and filename patterns.

Usage:
  python3 fix_delillos.py --dry-run
  sudo python3 fix_delillos.py
"""

import os
import re
import sys
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, TIT2, TPE1, TPE2, TALB, TRCK, TDRC

DRY_RUN = "--dry-run" in sys.argv
BASE = "/mnt/Audio/Album/De Lillos"

# Filename pattern: "02 - Title.mp3" or just "Title.mp3"
TRACK_PATTERN = re.compile(r'^(\d+)\s*[-–]\s*(.+)\.(mp3|flac)$', re.IGNORECASE)
TITLE_ONLY = re.compile(r'^(.+)\.(mp3|flac)$', re.IGNORECASE)

fixes = 0
errors = 0

for dirpath, dirnames, filenames in os.walk(BASE):
    album_name = os.path.basename(dirpath)

    for fname in sorted(filenames):
        if not fname.lower().endswith('.mp3'):
            continue

        path = os.path.join(dirpath, fname)

        try:
            # Check if tags already exist
            audio = MP3(path)
            existing = dict(audio.tags) if audio.tags else {}

            # Only fix if tags are empty
            if existing:
                continue

            # Extract from filename
            m = TRACK_PATTERN.match(fname)
            if m:
                track_num, title, _ = m.groups()
                title = title.strip()
                track_str = track_num
            else:
                m = TITLE_ONLY.match(fname)
                if m:
                    title = m.group(1).strip()
                    track_str = None
                else:
                    continue

            # Create fresh tags
            if audio.tags is None:
                audio.add_tags()

            audio.tags.add(TIT2(encoding=3, text=title))
            audio.tags.add(TPE1(encoding=3, text="deLillos"))
            audio.tags.add(TPE2(encoding=3, text="deLillos"))
            audio.tags.add(TALB(encoding=3, text=album_name))

            if track_str:
                audio.tags.add(TRCK(encoding=3, text=track_str))

            if not DRY_RUN:
                audio.save()
            fixes += 1

            if fixes <= 5:
                print(f"{'[DRY RUN]' if DRY_RUN else '[FIXED]'} {path}")
                print(f"  title='{title}', album='{album_name}', track='{track_str}'")

        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"[ERROR] {path}: {e}")

print()
print(f"Fixes: {fixes}, Errors: {errors}, DRY RUN: {DRY_RUN}")
