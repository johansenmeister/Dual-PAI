#!/usr/bin/env python3
"""
Navidrome tag fixer v4 — Case & unicode normalization.

Problem: Tracks in same album have different casing ("1001 fnatt" vs "1001 Fnatt"),
unicode variants (different dash characters, ellipsis), or trailing spaces.
Navidrome treats these as different albums.

Strategy (per-directory, safe):
  1. Group tracks by case-insensitive + unicode-normalized album name
  2. Normalize to most common casing within each group
  3. Same for albumartist — plus normalize "Various" variants
  4. Only normalize WITHIN the same directory (never merge across dirs)
  5. Don't merge albums that differ beyond casing (e.g., "2112" vs "2112 Days")

Usage:
  python3 fix_case_v4.py --dry-run
  sudo python3 fix_case_v4.py
"""

import json
import os
import sys
import unicodedata
from collections import Counter, defaultdict
from mutagen.mp3 import EasyMP3
from mutagen.flac import FLAC

# ── Configuration ──────────────────────────────────────────────
MUSIC_ROOT = "/mnt/Audio/Album"
REPORT_PATH = "/tmp/opencode/music-scan/tag-report.json"
LOG_PATH = "/tmp/opencode/music-scan/fix-case-v4.json"
DRY_RUN = "--dry-run" in sys.argv

# ── Normalization helpers ──────────────────────────────────────

def normalize_key(s):
    """Create a case-insensitive, unicode-normalized key for comparison."""
    if not s:
        return ""
    # NFKC normalization (combines characters, normalizes unicode)
    s = unicodedata.normalize('NFKC', s)
    # Lowercase
    s = s.lower()
    # Strip
    s = s.strip()
    # Collapse whitespace
    s = ' '.join(s.split())
    return s

def normalize_va(val):
    """Normalize Various Artists variations."""
    if not val:
        return val
    v = val.strip()
    v_lower = v.lower()
    mapping = {
        "various": "Various Artists",
        "various artist": "Various Artists",
        "various artists ": "Various Artists",
        "va": "Various Artists",
        "v.a.": "Various Artists",
        "various artist's": "Various Artists",
    }
    return mapping.get(v_lower, v)

# ── Build directory analysis from JSON report ──────────────────

def analyze_from_json():
    with open(REPORT_PATH) as f:
        report = json.load(f)

    # For each directory, collect all albumartist and album values
    dirs = defaultdict(lambda: {
        'aa_raw': Counter(),        # raw (as-is) albumartist values
        'alb_raw': Counter(),       # raw album values
        'aa_norm_groups': defaultdict(set),  # normalized_key -> set of raw values
        'alb_norm_groups': defaultdict(set),
        'tracks': [],               # (path, raw_aa, raw_alb)
        'total': 0,
    })

    for track in report['all_tracks']:
        path = track['path']
        dirpath = os.path.dirname(path)
        aa = track.get('albumartist')
        alb = track.get('album')

        if aa:
            dirs[dirpath]['aa_raw'][aa] += 1
            nk = normalize_key(aa)
            dirs[dirpath]['aa_norm_groups'][nk].add(aa)

        if alb:
            dirs[dirpath]['alb_raw'][alb] += 1
            nk = normalize_key(alb)
            dirs[dirpath]['alb_norm_groups'][nk].add(alb)

        dirs[dirpath]['tracks'].append((path, aa, alb))
        dirs[dirpath]['total'] += 1

    return dirs

# ── Determine what to fix ──────────────────────────────────────

def determine_fixes(dirs):
    """
    For each directory, find (albumartist, album) pairs that need normalization.
    Returns list of (path, tag, old_value, new_value, reason)
    """
    fixes = []

    for dirpath, data in dirs.items():
        dirname = os.path.basename(dirpath)
        total = data['total']
        if total < 2:
            continue

        # ── Albumartist: find groups with multiple raw values ──
        for norm_key, raw_vals in data['aa_norm_groups'].items():
            if len(raw_vals) <= 1:
                continue

            # Multiple spellings of same albumartist — normalize to most common
            best = max(raw_vals, key=lambda v: data['aa_raw'][v])
            other = raw_vals - {best}

            # Only do this if the best has reasonable confidence (>30% of all variants)
            total_count = sum(data['aa_raw'][v] for v in raw_vals)
            best_count = data['aa_raw'][best]
            if total_count == 0 or best_count / total_count < 0.5:
                continue

            for old in other:
                for path, track_aa, track_alb in data['tracks']:
                    if track_aa == old:
                        fixes.append({
                            'path': path,
                            'tag': 'albumartist',
                            'old': old,
                            'new': best,
                            'reason': f"normalize '{old}' → '{best}'",
                            'dirname': dirname,
                        })

        # ── Album: find groups with multiple raw values ──
        for norm_key, raw_vals in data['alb_norm_groups'].items():
            if len(raw_vals) <= 1:
                continue

            best = max(raw_vals, key=lambda v: data['alb_raw'][v])
            other = raw_vals - {best}

            total_count = sum(data['alb_raw'][v] for v in raw_vals)
            best_count = data['alb_raw'][best]
            if total_count == 0 or best_count / total_count < 0.5:
                continue

            for old in other:
                for path, track_aa, track_alb in data['tracks']:
                    if track_alb == old:
                        fixes.append({
                            'path': path,
                            'tag': 'album',
                            'old': old,
                            'new': best,
                            'reason': f"normalize '{old}' → '{best}'",
                            'dirname': dirname,
                        })

        # ── Various Artists normalization ──
        va_norm_needed = False
        for raw_val in data['aa_raw']:
            normed = normalize_va(raw_val)
            if normed != raw_val:
                va_norm_needed = True
                break

        if va_norm_needed:
            # Find the VA value that already exists, or use "Various Artists"
            va_target = None
            for raw_val in data['aa_raw']:
                if normalize_key(raw_val) == "various artists":
                    va_target = raw_val
                    break
            if not va_target:
                va_target = "Various Artists"

            for path, track_aa, track_alb in data['tracks']:
                if track_aa and normalize_va(track_aa) != track_aa and track_aa != va_target:
                    fixes.append({
                        'path': path,
                        'tag': 'albumartist',
                        'old': track_aa,
                        'new': va_target,
                        'reason': f"normalize VA: '{track_aa}' → '{va_target}'",
                        'dirname': dirname,
                    })

    return fixes

# ── Apply fixes ────────────────────────────────────────────────

def apply_fixes(fixes):
    applied = []
    failed = []
    total = len(fixes)

    for i, fix in enumerate(fixes):
        if i % 200 == 0:
            print(f"  Writing: {i}/{total}...")

        path = fix['path']
        try:
            ext = os.path.splitext(path)[1].lower()
            audio = EasyMP3(path) if ext == '.mp3' else FLAC(path)

            current = (audio.get(fix['tag']) or [None])[0]
            if current == fix['old']:
                if not DRY_RUN:
                    audio[fix['tag']] = [fix['new']]
                    audio.save()
                applied.append(fix)
            elif current == fix['new']:
                # Already correct
                applied.append(fix)
            else:
                # Value changed since scan — skip
                failed.append({**fix, 'error': f'on disk: {current}'})

        except Exception as e:
            failed.append({**fix, 'error': str(e)})

    return applied, failed

# ── Main ───────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("NAVIDROME CASE/UNICODE NORMALIZER v4")
    print("=" * 60)
    print(f"DRY RUN: {DRY_RUN}")
    print()

    print("Step 1: Analyzing from JSON report...")
    dirs = analyze_from_json()

    # Count directories with issues
    dirs_with_aa_issues = sum(1 for d in dirs.values() if any(len(v) > 1 for v in d['aa_norm_groups'].values()))
    dirs_with_alb_issues = sum(1 for d in dirs.values() if any(len(v) > 1 for v in d['alb_norm_groups'].values()))

    print(f"  Directories: {len(dirs)}")
    print(f"  With albumartist case issues: {dirs_with_aa_issues}")
    print(f"  With album case issues: {dirs_with_alb_issues}")

    # Show sample issues
    print("\n  Sample albumartist case issues (first 10):")
    shown = 0
    for dirpath, data in sorted(dirs.items()):
        if shown >= 10:
            break
        for norm_key, raw_vals in data['aa_norm_groups'].items():
            if len(raw_vals) > 1 and shown < 10:
                rel = os.path.relpath(dirpath, MUSIC_ROOT) or '.'
                best = max(raw_vals, key=lambda v: data['aa_raw'][v])
                others = raw_vals - {best}
                print(f"    {rel}")
                print(f"      → '{best}' ({data['aa_raw'][best]} tracks)")
                for o in others:
                    print(f"      ⇢ '{o}' ({data['aa_raw'][o]} tracks)")
                shown += 1

    print("\n  Sample album case issues (first 10):")
    shown = 0
    for dirpath, data in sorted(dirs.items()):
        if shown >= 10:
            break
        for norm_key, raw_vals in data['alb_norm_groups'].items():
            if len(raw_vals) > 1 and shown < 10:
                rel = os.path.relpath(dirpath, MUSIC_ROOT) or '.'
                best = max(raw_vals, key=lambda v: data['alb_raw'][v])
                others = raw_vals - {best}
                print(f"    {rel}")
                print(f"      → '{best}' ({data['alb_raw'][best]} tracks)")
                for o in others:
                    print(f"      ⇢ '{o}' ({data['alb_raw'][o]} tracks)")
                shown += 1

    print()
    print("Step 2: Determining fixes...")
    fixes = determine_fixes(dirs)

    # Stats
    by_tag = Counter()
    for fix in fixes:
        by_tag[fix['tag']] += 1

    print(f"  Total fixes: {len(fixes)}")
    for tag, count in by_tag.most_common():
        print(f"    {tag}: {count}")

    # Show examples
    if fixes:
        print(f"\n  Example fixes (first 15):")
        for fix in fixes[:15]:
            print(f"    [{fix['dirname']}] {os.path.basename(fix['path'])}")
            print(f"      {fix['tag']}: {fix['reason']}")

    print()
    print(f"Step 3: {'DRY RUN (no writes)' if DRY_RUN else 'Applying fixes...'}")
    applied, failed = apply_fixes(fixes)

    print()
    print("=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"Applied: {len(applied)}")
    print(f"Failed: {len(failed)}")
    print(f"DRY RUN: {DRY_RUN}")

    log = {
        'dry_run': DRY_RUN,
        'applied': len(applied),
        'failed': len(failed),
        'applied_fixes': applied,
        'failed_fixes': failed,
    }
    with open(LOG_PATH, 'w') as f:
        json.dump(log, f, indent=2)

    print(f"\nLog: {LOG_PATH}")

if __name__ == '__main__':
    main()
