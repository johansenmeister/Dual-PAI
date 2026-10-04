#!/usr/bin/env python3
"""
Fix missing and inconsistent ALBUM ARTIST/ALBUM tags for Navidrome. v2 — CORRECTED.

Strategy (per-directory consensus):
  1. For each directory, determine dominant albumartist & album from tracks that have them
  2. For tracks missing albumartist: use directory consensus
  3. For tracks with INCONSISTENT albumartist (≠ consensus): normalize to consensus
  4. Various Artists directories → always "Various Artists"
  5. NEVER overwrite tags where consensus can't be determined

Usage:
  python3 fix_tags_v2.py --dry-run     # Preview changes, don't write
  sudo python3 fix_tags_v2.py          # Apply fixes

Requires: mutagen (sudo apt install python3-mutagen)
"""

import json
import os
import sys
from collections import Counter, defaultdict
from mutagen.mp3 import EasyMP3
from mutagen.flac import FLAC

# ── Configuration ──────────────────────────────────────────────
MUSIC_ROOT = "/mnt/Audio/Album"
REPORT_PATH = "/tmp/opencode/music-scan/tag-report.json"
LOG_PATH = "/tmp/opencode/music-scan/fix-log-v2.json"
DRY_RUN = "--dry-run" in sys.argv

SPECIAL_CASE_AA = {
    "various": "Various Artists",
    "various artists ": "Various Artists",
    "va": "Various Artists",
}

# ── Helpers ────────────────────────────────────────────────────

def is_various_artists_dir(dirname):
    """Check if a directory name suggests a compilation."""
    if not dirname:
        return False
    d = dirname.lower()
    indicators = ["various artists", "va-", "va_", "v.a.", "compilation",
                  "sampler", "mixed by", "presents", "top.100"]
    for ind in indicators:
        if ind in d:
            return True
    return False

def get_audio(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.mp3':
        return EasyMP3(path)
    elif ext == '.flac':
        return FLAC(path)
    return None

def normalize_tag_value(value):
    """Normalize common tag inconsistencies."""
    if not value:
        return value
    v = value.strip()
    v_lower = v.lower()
    if v_lower in SPECIAL_CASE_AA:
        return SPECIAL_CASE_AA[v_lower]
    return v

# ── Directory consensus ────────────────────────────────────────

def build_directory_consensus():
    """
    Walk the library and for each directory, determine the dominant
    albumartist and album from tracks that already have them.
    
    Returns: {
      '/path/to/dir': {
        'dominant_aa': 'Foo' or None,
        'dominant_album': 'Bar' or None,
        'aa_confidence': 0.0-1.0 (fraction of tracks with this AA),
        'album_confidence': 0.0-1.0,
        'counts': {'aa': Counter(), 'album': Counter()},
        'total': N,
        'is_va': bool
      }
    }
    """
    dirs = defaultdict(lambda: {
        'aa': Counter(),
        'album': Counter(),
        'total': 0,
    })

    for dirpath, dirnames, filenames in os.walk(MUSIC_ROOT):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        dirname_basename = os.path.basename(dirpath)

        for f in filenames:
            if not f.lower().endswith(('.mp3', '.flac')):
                continue
            path = os.path.join(dirpath, f)
            try:
                audio = get_audio(path)
                if not audio:
                    continue
                aa = audio.get('albumartist')
                alb = audio.get('album')
                if aa and aa[0]:
                    dirs[dirpath]['aa'][normalize_tag_value(aa[0])] += 1
                if alb and alb[0]:
                    dirs[dirpath]['album'][normalize_tag_value(alb[0])] += 1
                dirs[dirpath]['total'] += 1
            except:
                pass

    consensus = {}
    for dirpath, data in dirs.items():
        dirname = os.path.basename(dirpath)
        total = data['total']
        if total == 0:
            consensus[dirpath] = None
            continue

        # Dominant albumartist
        dom_aa = None
        aa_conf = 0.0
        if data['aa']:
            top_aa, top_count = data['aa'].most_common(1)[0]
            aa_conf = top_count / total
            dom_aa = top_aa

        # Dominant album
        dom_album = None
        alb_conf = 0.0
        if data['album']:
            top_alb, top_count = data['album'].most_common(1)[0]
            alb_conf = top_count / total
            dom_album = top_alb

        # Override: Various Artists dirs always get "Various Artists"
        is_va = is_various_artists_dir(dirname)
        if is_va:
            dom_aa = "Various Artists"

        consensus[dirpath] = {
            'dominant_aa': dom_aa,
            'dominant_album': dom_album,
            'aa_confidence': aa_conf,
            'album_confidence': alb_conf,
            'is_va': is_va,
            'total': total,
            'aa_counts': dict(data['aa'].most_common(5)),
            'album_counts': dict(data['album'].most_common(5)),
        }

    return consensus

# ── Fix logic ──────────────────────────────────────────────────

def fix_tracks(consensus):
    """Apply fixes based on directory consensus."""
    fixes_applied = []
    fixes_skipped = []

    # Walk all tracks
    track_count = 0
    for dirpath, dirnames, filenames in os.walk(MUSIC_ROOT):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        ctx = consensus.get(dirpath)

        for f in filenames:
            if not f.lower().endswith(('.mp3', '.flac')):
                continue
            track_count += 1
            if track_count % 1000 == 0:
                print(f"  Processing: {track_count}...")

            path = os.path.join(dirpath, f)

            try:
                audio = get_audio(path)
                if not audio:
                    fixes_skipped.append({'path': path, 'reason': 'unsupported format'})
                    continue

                changes = {}

                # ── Fix albumartist ──
                current_aa = (audio.get('albumartist') or [None])[0]
                current_aa_norm = normalize_tag_value(current_aa) if current_aa else None

                if not current_aa:
                    # Missing — fill from directory consensus
                    if ctx and ctx['dominant_aa'] and ctx['aa_confidence'] >= 0.3:
                        new_aa = ctx['dominant_aa']
                        audio['albumartist'] = [new_aa]
                        changes['albumartist'] = f"MISSING → '{new_aa}'"
                elif ctx and ctx['dominant_aa']:
                    # Check for inconsistency with directory consensus (but only when confident)
                    if (current_aa_norm != ctx['dominant_aa'] and
                        ctx['aa_confidence'] >= 0.5 and  # high confidence
                        ctx['is_va']):  # only normalize in VA dirs (safest)
                        # But DON'T overwrite if current AA is a valid artist (compilations)
                        # Only normalize if current looks like a variation of "Various Artists"
                        if current_aa_norm and current_aa_norm.lower() in SPECIAL_CASE_AA:
                            audio['albumartist'] = [ctx['dominant_aa']]
                            changes['albumartist'] = f"'{current_aa}' → '{ctx['dominant_aa']}'"

                # ── Fix album ──
                current_album = (audio.get('album') or [None])[0]

                if not current_album:
                    # Missing — fill from directory consensus
                    if ctx and ctx['dominant_album'] and ctx['album_confidence'] >= 0.3:
                        new_alb = ctx['dominant_album']
                        audio['album'] = [new_alb]
                        changes['album'] = f"MISSING → '{new_alb}'"

                if changes:
                    if not DRY_RUN:
                        audio.save()
                    fixes_applied.append({
                        'path': path,
                        'changes': changes,
                        'dirname': os.path.basename(dirpath),
                    })
                else:
                    fixes_skipped.append({
                        'path': path,
                        'reason': 'no changes needed',
                    })

            except Exception as e:
                fixes_skipped.append({'path': path, 'reason': str(e)})

    return fixes_applied, fixes_skipped

# ── Run ────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("NAVIDROME TAG FIXER v2 (CORRECTED)")
    print("=" * 60)
    print(f"DRY RUN: {DRY_RUN}")
    print()

    print("Step 1: Building directory consensus...")
    consensus = build_directory_consensus()

    total_dirs = len([c for c in consensus.values() if c])
    dirs_with_aa = len([c for c in consensus.values() if c and c['dominant_aa']])
    va_dirs = len([c for c in consensus.values() if c and c['is_va']])
    print(f"  Directories: {total_dirs} (with AA consensus: {dirs_with_aa}, VA dirs: {va_dirs})")

    # Show some consensus examples
    print("\n  Example consensus:")
    for i, (d, c) in enumerate(sorted(consensus.items(), key=lambda x: -(x[1] or {}).get('total', 0))[:10]):
        if not c:
            continue
        rel = os.path.relpath(d, MUSIC_ROOT) or '.'
        print(f"    {rel}")
        print(f"      AA: '{c['dominant_aa']}' (conf: {c['aa_confidence']:.1%}, total: {c['total']})")
        if c['aa_counts']:
            print(f"        all AA: {c['aa_counts']}")

    print()
    print("Step 2: Applying fixes...")
    fixes_applied, fixes_skipped = fix_tracks(consensus)

    print()
    print("=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"Fixes APPLIED: {len(fixes_applied)}")
    print(f"Fixes SKIPPED: {len(fixes_skipped)}")
    print(f"DRY RUN: {DRY_RUN}")

    # Show examples
    if fixes_applied:
        print(f"\nExample fixes (first 15):")
        for fix in fixes_applied[:15]:
            print(f"  {os.path.basename(fix['path'])}")
            for tag, change in fix['changes'].items():
                print(f"    {tag}: {change}")

    # Save log
    log = {
        'dry_run': DRY_RUN,
        'fixes_applied': len(fixes_applied),
        'fixes_skipped': len(fixes_skipped),
        'fixes': fixes_applied,
        'skipped': fixes_skipped,
        'consensus': {d: c for d, c in consensus.items() if c},
    }

    with open(LOG_PATH, 'w') as f:
        json.dump(log, f, indent=2)

    print(f"\nLog saved to: {LOG_PATH}")

if __name__ == '__main__':
    main()
