-- Navidrome content purge — preserves user accounts, clears all scanned content.
-- Run against a STOPPED Navidrome, on /data/navidrome.db.
-- FTS5 shadow indexes stay consistent via existing AFTER DELETE triggers
-- (media_file_fts_ad, album_fts_ad, artist_fts_ad) — do NOT touch *_fts tables.
-- Tested on a copy: integrity OK, users preserved, 160MB -> ~7MB.

PRAGMA foreign_keys=OFF;

BEGIN;
DELETE FROM media_file_artists;
DELETE FROM album_artists;
DELETE FROM library_artist;
DELETE FROM library_tag;
DELETE FROM playlist_tracks;
DELETE FROM playlist_fields;
DELETE FROM playlist;
DELETE FROM annotation;
DELETE FROM scrobbles;
DELETE FROM scrobble_buffer;
DELETE FROM bookmark;
DELETE FROM playqueue;
DELETE FROM player;
DELETE FROM tag;
DELETE FROM media_file;
DELETE FROM album;
DELETE FROM artist;
DELETE FROM folder;
COMMIT;

VACUUM;

-- Verification
SELECT 'users' AS what, COUNT(*) AS n FROM user
UNION ALL SELECT 'media_file', COUNT(*) FROM media_file
UNION ALL SELECT 'album', COUNT(*) FROM album
UNION ALL SELECT 'artist', COUNT(*) FROM artist
UNION ALL SELECT 'playlist', COUNT(*) FROM playlist;
