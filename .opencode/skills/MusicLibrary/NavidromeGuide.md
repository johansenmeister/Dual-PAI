# Navidrome Guide

Navidrome-specific requirements and pitfalls for music library organization.

## Tag Priority

Navidrome reads these tags (in order of importance):

| Priority | Tag | Effect When Missing |
|----------|-----|---------------------|
| 🔴 Critical | `ALBUM ARTIST` | Album appears under "Unknown Artist" |
| 🔴 Critical | `ARTIST` | Track has no artist in playlist |
| 🔴 Critical | `ALBUM` | Track has no album grouping |
| 🟠 High | `DATE` / `YEAR` | No chronological sorting, appears as "0000" |
| 🟡 Medium | `GENRE` | No genre filtering available |
| 🟡 Medium | `TRACK` / `TRACKTOTAL` | Tracks sort alphabetically instead of by track order |
| 🟡 Medium | `DISC` / `DISCTOTAL` | Multi-disc albums show as one flat list |
| 🟢 Low | `COMPILATION` | Compilations grouped under track artists instead of Various Artists |

## Various Artists

- All compilations need `album_artist = Various Artists` on EVERY track
- `COMPILATION = 1` flag helps Navidrome group them correctly
- Folder should be `Various Artists/Year - Album Name/`
- Track-level `ARTIST` stays as the actual performer

## Folder Structure (Fallback)

Navidrome uses folder structure as fallback when tags are missing:
```
Artist/
├── Year - Album/
│   ├── 01 - Track Title.mp3
│   └── 02 - Track Title.mp3
└── Year - Another Album/
```

## Non-Music Files

Navidrome safely ignores:
- `.DS_Store`, `desktop.ini`
- `.sfv`, `.m3u`, `.cue`, `.nfo`
- `.jpg`, `.png` (uses as album art if named `cover.jpg` or `folder.jpg`)

## Common Pitfalls

1. **Same artist, different spellings:** "AC/DC" vs "ACDC" → two separate artists in Navidrome
2. **Missing ALBUM ARTIST on compilations:** Each track artist becomes a separate "album"
3. **Year format:** YYYY-MM-DD works but YYYY is cleaner for chronological browsing
4. **Scene release junk:** TMED/TDOR/TSO2/SCRIPT tags don't affect Navidrome — skip removal if over CIFS
