#!/usr/bin/env python3
"""
Fix missing and inconsistent ALBUM ARTIST/ALBUM tags for Navidrome. v3 — JSON-based.

Uses pre-scanned JSON report for consensus (fast), mutagen only for writes.

Strategy:
  1. Build directory consensus from JSON report (no mutagen reads needed)
  2. For each directory, find dominant albumartist & album
  3. Normalize Various Artists variations
  4. Fill missing / inconsistent tags based on consensus
  5. Only use mutagen when actually writing tags

Usage:
  python3 fix_tags_v3.py --dry-run     # Preview changes (no mutagen reads)
  sudo python3 fix_tags_v3.py          # Apply fixes (writes only)

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
LOG_PATH = "/tmp/opencode/music-scan/fix-log-v3.json"
DRY_RUN = "--dry-run" in sys.argv

VA_NORMALIZE = {
    "various": "Various Artists",
    "various artists ": "Various Artists",
    "va": "Various Artists",
    "various artist": "Various Artists",
}

def is_va_dirname(dirname):
    if not dirname:
        return False
    d = dirname.lower()
    for ind in ["various artists", "va-", "va_", "v.a.", "compilation",
                "sampler", "mixed by", "presents", "top.100", "tunnel goes",
                "my ibiza", "cream ibiza", "trance energy", "trancemasters"]:
        if ind in d:
            return True
    return False

def normalize_aa(val):
    if not val:
        return val
    v = val.strip()
    return VA_NORMALIZE.get(v.lower(), v)

# ── Phase 1: Build consensus from JSON (fast, no mutagen) ─────

def build_consensus_from_json():
    with open(REPORT_PATH) as f:
        report = json.load(f)

    dirs = defaultdict(lambda: {'aa': Counter(), 'album': Counter(), 'total': 0})

    for track in report['all_tracks']:
        # Determine the actual directory this track is in
        # dirpath is derived from path
        path = track['path']
        dirpath = os.path.dirname(path)
        dirname = os.path.basename(dirpath)

        aa = track.get('albumartist')
        alb = track.get('album')

        if aa:
            dirs[dirpath]['aa'][normalize_aa(aa)] += 1
        if alb:
            dirs[dirpath]['album'][alb.strip()] += 1
        dirs[dirpath]['total'] += 1

    consensus = {}
    for dirpath, data in dirs.items():
        dirname = os.path.basename(dirpath)
        total = data['total']
        if total == 0:
            continue

        dom_aa = None
        aa_conf = 0.0
        if data['aa']:
            top_aa, top_count = data['aa'].most_common(1)[0]
            aa_conf = top_count / total
            dom_aa = top_aa

        dom_album = None
        alb_conf = 0.0
        if data['album']:
            top_alb, top_count = data['album'].most_common(1)[0]
            alb_conf = top_count / total
            dom_album = top_alb

        is_va = is_va_dirname(dirname)
        if is_va and dom_aa is None:
            dom_aa = "Various Artists"
            aa_conf = 1.0

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

# ── Phase 2: Determine what to fix (from JSON, fast) ───────────

def determine_fixes(consensus):
    with open(REPORT_PATH) as f:
        report = json.load(f)

    to_fix = []  # list of (path, changes_dict)
    skipped = []

    for track in report['all_tracks']:
        path = track['path']
        dirpath = os.path.dirname(path)
        dirname = os.path.basename(dirpath)
        ctx = consensus.get(dirpath)

        changes = {}

        current_aa = track.get('albumartist')
        current_album = track.get('album')

        # ── Fix albumartist ──
        if not current_aa:
            # Missing
            if ctx and ctx['dominant_aa'] and ctx['aa_confidence'] >= 0.3:
                changes['albumartist'] = {'old': None, 'new': ctx['dominant_aa'], 'reason': 'missing'}
        elif ctx and ctx['dominant_aa']:
            # Check for inconsistency
            aa_norm = normalize_aa(current_aa)
            if aa_norm != ctx['dominant_aa']:
                # Only normalize in various artists directories (safe)
                if ctx['is_va'] and current_aa.strip().lower() in VA_NORMALIZE:
                    changes['albumartist'] = {'old': current_aa, 'new': ctx['dominant_aa'],
                                              'reason': f'normalize VA: {current_aa}→{ctx["dominant_aa"]}'}

        # ── Fix album ──
        if not current_album:
            if ctx and ctx['dominant_album'] and ctx['album_confidence'] >= 0.3:
                changes['album'] = {'old': None, 'new': ctx['dominant_album'], 'reason': 'missing'}

        if changes:
            to_fix.append({'path': path, 'changes': changes, 'dirname': dirname})
        else:
            skipped.append({'path': path, 'reason': 'no changes needed',
                           'aa': current_aa, 'album': current_album})

    return to_fix, skipped

# ── Phase 3: Write tags (mutagen writes only) ──────────────────

def apply_fixes(to_fix):
    applied = []
    failed = []
    total = len(to_fix)

    for i, fix in enumerate(to_fix):
        if i % 500 == 0:
            print(f"  Writing: {i}/{total}...")

        path = fix['path']
        try:
            audio = get_audio(path)
            if not audio:
                failed.append({**fix, 'error': 'unsupported format'})
                continue

            # Check current state on disk (might differ from scan if something changed)
            disk_aa = (audio.get('albumartist') or [None])[0]
            disk_album = (audio.get('album') or [None])[0]

            wrote = False
            for tag, change in fix['changes'].items():
                if tag == 'albumartist':
                    # Check if we still need to write (might have been fixed manually)
                    if not disk_aa or normalize_aa(disk_aa) != change['new']:
                        if not DRY_RUN:
                            audio['albumartist'] = [change['new']]
                        wrote = True
                elif tag == 'album':
                    if not disk_album:
                        if not DRY_RUN:
                            audio['album'] = [change['new']]
                        wrote = True

            if wrote and not DRY_RUN:
                audio.save()
                applied.append(fix)
            elif wrote:
                applied.append(fix)  # dry-run counts as applied
            else:
                failed.append({**fix, 'error': 'no changes needed on disk'})

        except Exception as e:
            failed.append({**fix, 'error': str(e)})

    return applied, failed

# ── Helpers ────────────────────────────────────────────────────

def get_audio(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.mp3':
        return EasyMP3(path)
    elif ext == '.flac':
        return FLAC(path)
    return None

# ── Main ───────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("NAVIDROME TAG FIXER v3 (JSON-based consensus)")
    print("=" * 60)
    print(f"DRY RUN: {DRY_RUN}")
    print()

    # Phase 1: Build consensus from JSON (fast)
    print("Phase 1: Building directory consensus from JSON report...")
    consensus = build_consensus_from_json()
    total_dirs = len(consensus)
    dirs_with_aa = sum(1 for c in consensus.values() if c['dominant_aa'])
    va_dirs = sum(1 for c in consensus.values() if c['is_va'])
    print(f"  Directories: {total_dirs} (with AA: {dirs_with_aa}, VA: {va_dirs})")

    # Show sample consensus
    print("\n  Sample consensus (top 10 by track count):")
    sorted_dirs = sorted(consensus.items(), key=lambda x: -x[1]['total'])
    for i, (d, c) in enumerate(sorted_dirs[:10]):
        rel = os.path.relpath(d, MUSIC_ROOT) or '.'
        aa_str = f"'{c['dominant_aa']}'" if c['dominant_aa'] else 'NONE'
        print(f"    {rel} [{c['total']} tracks] → AA: {aa_str} (conf: {c['aa_confidence']:.0%})")
        if len(c['aa_counts']) > 1:
            print(f"      AA variations: {c['aa_counts']}")

    # Phase 2: Determine fixes (from JSON, fast)
    print(f"\nPhase 2: Determining fixes...")
    to_fix, skipped = determine_fixes(consensus)
    print(f"  To fix: {len(to_fix)}")
    print(f"  To skip: {len(skipped)}")

    # Show examples
    if to_fix:
        print(f"\n  Example fixes (first 15):")
        for fix in to_fix[:15]:
            fname = os.path.basename(fix['path'])
            dirname = fix['dirname']
            changes_str = ', '.join(
                f"{tag}: {c['reason']}" for tag, c in fix['changes'].items()
            )
            print(f"    [{dirname}] {fname}")
            print(f"      {changes_str}")

    # Stats by fix type
    fix_reasons = Counter()
    for fix in to_fix:
        for tag, c in fix['changes'].items():
            fix_reasons[c['reason']] += 1
    print(f"\n  Fix breakdown:")
    for reason, count in fix_reasons.most_common():
        print(f"    {reason}: {count}")

    # Phase 3: Apply (mutagen writes)
    print(f"\nPhase 3: {'DRY RUN (no writes)' if DRY_RUN else 'Applying fixes...'}")
    applied, failed = apply_fixes(to_fix)

    print()
    print("=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"Applied: {len(applied)}")
    print(f"Failed: {len(failed)}")
    print(f"DRY RUN: {DRY_RUN}")

    # Save log
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
