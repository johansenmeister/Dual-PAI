#!/usr/bin/env python3
"""
Navidrome content purge — clears all scanned content, preserves user accounts.

WHY: Navidrome's DB accumulated ~2,852 stale duplicate media_file rows from an
old scanner generation (May 2025). Full rescans never purge them (paths still
exist). This wipes all content tables so a fresh full scan rebuilds cleanly,
with the new ND_PID_ALBUM grouping. User logins (usernames + password hashes)
are preserved.

TESTED: on a copy — integrity OK, 5 users preserved, 160MB→7MB.

Mechanism: delete ONLY base content tables. FTS5 shadow indexes are kept in
sync automatically by existing AFTER DELETE triggers (media_file_fts_ad, etc).
Do NOT delete FTS shadow tables directly — that corrupts the inverted index.

Usage (on the docker host, against a STOPPED Navidrome):
  python3 purge_navidrome_content.py /path/to/navidrome.db

Preserves: user, user_library, user_props, library, goose_db_version,
           property, transcoding, plugin, radio, share
Wipes:     media_file, album, artist, folder, tag, playlists, annotations,
           scrobbles, players, bookmarks, and all junction tables.
"""
import sqlite3
import sys
import os

# Base content tables, deletion order (junctions → leaves → parents).
# FTS virtual/shadow tables are handled by triggers — never touch them directly.
CONTENT_ORDER = [
    'media_file_artists', 'album_artists', 'library_artist', 'library_tag',
    'playlist_tracks', 'playlist_fields', 'playlist',
    'annotation', 'scrobbles', 'scrobble_buffer', 'bookmark',
    'playqueue', 'player', 'tag',
    'media_file', 'album', 'artist', 'folder',
]

PRESERVED = ['user', 'user_library', 'library', 'goose_db_version']

def main():
    if len(sys.argv) < 2:
        print("Usage: purge_navidrome_content.py /path/to/navidrome.db")
        sys.exit(1)
    db = sys.argv[1]
    if not os.path.exists(db):
        print(f"DB not found: {db}")
        sys.exit(1)

    size_before = os.path.getsize(db) / 1e6
    con = sqlite3.connect(db)
    c = con.cursor()

    # Show users before (sanity)
    print("Users before:")
    for r in c.execute("SELECT user_name, is_admin FROM user"):
        print(f"  {r[0]} admin={r[1]}")

    c.execute("PRAGMA foreign_keys=OFF")
    errs = []
    for t in CONTENT_ORDER:
        try:
            c.execute(f"DELETE FROM '{t}'")
        except Exception as e:
            errs.append((t, str(e)))
    con.commit()

    if errs:
        print("\nERRORS (aborting, no VACUUM):")
        for t, e in errs:
            print(f"  {t}: {e}")
        con.close()
        sys.exit(2)

    # Integrity check before finalizing
    c.execute("PRAGMA integrity_check")
    integ = c.fetchone()[0]
    print(f"\nintegrity_check: {integ}")
    if integ != 'ok':
        print("Integrity NOT ok — aborting before VACUUM.")
        con.close()
        sys.exit(3)

    con.commit()
    c.execute("VACUUM")
    con.commit()

    size_after = os.path.getsize(db) / 1e6
    print("\nContent after purge:")
    for t in ['media_file', 'album', 'artist', 'folder', 'playlist']:
        print(f"  {t}: {c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
    print("Preserved:")
    for t in PRESERVED:
        print(f"  {t}: {c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
    print(f"\nSize: {size_before:.1f} MB → {size_after:.1f} MB")

    print("\nUsers after:")
    for r in c.execute("SELECT user_name, is_admin, length(password) FROM user"):
        print(f"  {r[0]} admin={r[1]} pwhash_len={r[2]}")

    con.close()
    print("\nDONE. Start Navidrome and trigger a full scan.")

if __name__ == '__main__':
    main()
