#!/usr/bin/env python3
"""
Fix missing ALBUM ARTIST and ALBUM tags in music library for Navidrome.

Strategy:
  1. For tracks missing albumartist: infer from directory structure or artist tag
  2. For tracks missing album: infer from parent directory name
  3. NEVER overwrite existing tags — only fill gaps
  4. Logs all changes to a JSON log file

Usage:
  python3 fix_tags.py --dry-run     # Preview changes, don't write
  python3 fix_tags.py               # Apply fixes

Requires: mutagen (sudo apt install python3-mutagen)

Saved in: .opencode/scripts/music-fix/fix_tags.py
"""

import json
import os
import sys
from collections import Counter
from mutagen.mp3 import EasyMP3
from mutagen.flac import FLAC

# ── Configuration ──────────────────────────────────────────────
REPORT_PATH = "/tmp/opencode/music-scan/tag-report.json"
LOG_PATH = "/tmp/opencode/music-scan/fix-log.json"
DRY_RUN = "--dry-run" in sys.argv

# Directories that should get "Various Artists" as albumartist
VARIOUS_ARTIST_PATTERNS = [
    "various artists", "va-", "va_", "v.a.", "v/a/",
    "compilation", "sampler", "mixed by", "presents",
]

# ── Helpers ────────────────────────────────────────────────────

def is_various_artists_dir(dirname):
    """Check if a directory name suggests a compilation."""
    d = dirname.lower()
    if "various artists" in d:
        return True
    for pattern in VARIOUS_ARTIST_PATTERNS:
        if pattern in d:
            return True
    return False

def get_audio(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.mp3':
        return EasyMP3(path)
    elif ext == '.flac':
        return FLAC(path)
    return None

def set_tag(audio, tag, value):
    """Set a tag if it's not already set. Returns True if changed."""
    existing = audio.get(tag)
    if existing and existing[0]:
        return False
    audio[tag] = [value]
    return True

def write_tags(audio, path):
    if DRY_RUN:
        return
    audio.save()

# ── Main fix logic ─────────────────────────────────────────────

def build_directory_context(report):
    """
    For each directory, determine the dominant albumartist from tracks that HAVE it.
    Returns: {dirname: {'dominant_aa': str, 'total': int, 'has_aa': int}}
    """
    dirs = {}
    for track in report['all_tracks']:
        dname = track['parent_dirname'] or track['dirname']
        if dname not in dirs:
            dirs[dname] = {'tracks': [], 'aa_counts': Counter()}
        
        dirs[dname]['tracks'].append(track)
        if track.get('albumartist'):
            dirs[dname]['aa_counts'][track['albumartist']] += 1

    context = {}
    for dname, data in dirs.items():
        if data['aa_counts']:
            dominant = data['aa_counts'].most_common(1)[0][0]
        else:
            dominant = None
        context[dname] = {
            'dominant_aa': dominant,
            'total': len(data['tracks']),
            'has_aa': sum(data['aa_counts'].values()),
            'all_aa': dict(data['aa_counts'].most_common(5)),
        }
    return context

def determine_albumartist(track, dir_context):
    """Determine the correct albumartist for a track that's missing it."""
    dname = track['parent_dirname'] or track['dirname']
    ctx = dir_context.get(dname, {})

    # 1. If directory has dominant albumartist, use that
    if ctx.get('dominant_aa'):
        return ctx['dominant_aa']

    # 2. If directory looks like Various Artists
    if is_various_artists_dir(dname):
        return "Various Artists"

    # 3. If parent directory (artist folder) exists and is meaningful
    parent = track.get('parent_dirname', '')
    if parent and parent not in ('Album', '', '.'):
        # Check if parent looks like an artist name
        parent_ctx = dir_context.get(parent, {})
        if parent_ctx.get('dominant_aa'):
            return parent_ctx['dominant_aa']
        return parent

    # 4. If directory name looks like an artist (not a scene release)
    if dname and dname not in ('Album', ''):
        return dname

    # 5. Fall back to artist tag
    if track.get('artist'):
        return track['artist']

    return None

def determine_album(track):
    """Determine the correct album for a track that's missing it."""
    dname = track.get('dirname', '')

    if not dname or dname == 'Album':
        return None

    # Don't use if it looks like an artist name (no year/album pattern)
    # Simple heuristic: if dirname has a year or known album separators
    if is_various_artists_dir(dname):
        return dname

    return dname

def fix_tracks(report):
    """Main fix routine."""
    dir_context = build_directory_context(report)

    fixes_applied = []
    fixes_skipped = []
    total_fixed = 0

    problem_files = report['problem_files']
    all_missing_aa = set(problem_files.get('missing_albumartist', []))
    all_missing_album = set(problem_files.get('missing_album', []))
    all_missing_both = set(problem_files.get('missing_both', []))

    to_process = all_missing_aa | all_missing_album | all_missing_both

    print(f"Tracks to process: {len(to_process)}")
    print(f"  Missing albumartist only: {len(all_missing_aa - all_missing_both)}")
    print(f"  Missing album only: {len(all_missing_album - all_missing_both)}")
    print(f"  Missing both: {len(all_missing_both)}")
    print(f"  DRY RUN: {DRY_RUN}")
    print()

    for i, path in enumerate(sorted(to_process)):
        if i % 200 == 0:
            print(f"  Processing: {i}/{len(to_process)}...")

        track = next((t for t in report['all_tracks'] if t['path'] == path), None)
        if not track:
            continue

        try:
            audio = get_audio(path)
            if not audio:
                fixes_skipped.append({'path': path, 'reason': 'unsupported format'})
                continue

            changes = []

            # Fix albumartist if missing
            if not track.get('albumartist'):
                new_aa = determine_albumartist(track, dir_context)
                if new_aa:
                    if set_tag(audio, 'albumartist', new_aa):
                        changes.append(('albumartist', new_aa))

            # Fix album if missing
            if not track.get('album'):
                new_album = determine_album(track)
                if new_album:
                    if set_tag(audio, 'album', new_album):
                        changes.append(('album', new_album))

            if changes:
                write_tags(audio, path)
                fix_entry = {
                    'path': path,
                    'changes': dict(changes),
                    'dirname': track.get('dirname', ''),
                    'parent_dirname': track.get('parent_dirname', ''),
                }
                fixes_applied.append(fix_entry)
                total_fixed += 1
            else:
                fixes_skipped.append({
                    'path': path,
                    'reason': 'could not determine correct values',
                    'existing': {
                        'albumartist': track.get('albumartist'),
                        'album': track.get('album'),
                        'artist': track.get('artist'),
                    }
                })

        except Exception as e:
            fixes_skipped.append({'path': path, 'reason': str(e)})

    return fixes_applied, fixes_skipped, total_fixed

# ── Run ────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("NAVIDROME TAG FIXER")
    print("=" * 60)

    with open(REPORT_PATH) as f:
        report = json.load(f)

    fixes_applied, fixes_skipped, total_fixed = fix_tracks(report)

    print()
    print("=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"Fixes APPLIED: {len(fixes_applied)}")
    print(f"Fixes SKIPPED: {len(fixes_skipped)}")
    print(f"DRY RUN: {DRY_RUN}")

    # Show a few examples
    if fixes_applied:
        print(f"\nExample fixes (first 10):")
        for fix in fixes_applied[:10]:
            print(f"  {fix['path']}")
            for tag, value in fix['changes'].items():
                print(f"    {tag} → '{value}'")

    if fixes_skipped:
        print(f"\nExample skipped (first 10):")
        for skip in fixes_skipped[:10]:
            print(f"  {skip['path']}")
            print(f"    reason: {skip['reason']}")

    # Save log
    log = {
        'dry_run': DRY_RUN,
        'total_processed': len(fixes_applied) + len(fixes_skipped),
        'fixes_applied': len(fixes_applied),
        'fixes_skipped': len(fixes_skipped),
        'fixes': fixes_applied,
        'skipped': fixes_skipped,
    }

    with open(LOG_PATH, 'w') as f:
        json.dump(log, f, indent=2)

    print(f"\nLog saved to: {LOG_PATH}")

if __name__ == '__main__':
    main()
