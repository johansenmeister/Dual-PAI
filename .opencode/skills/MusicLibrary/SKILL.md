---
name: MusicLibrary
description: Music library organization for Navidrome. USE WHEN organize music, fix music tags, Navidrome library, clean metadata, beets, MusicBrainz tagging, music folder structure, album artist cleanup. SkillSearch('navidrome') for Navidrome specifics, SkillSearch('beets') for beets tips.
---

# MusicLibrary

Organize and tag music libraries for Navidrome with `Artist/Year - Album` folder structure and clean metadata tags.

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Reorganize** | "organize music folders", "fix folder names", "Navidrome folder structure" | `Workflows/Reorganize.md` |
| **FixMetadata** | "fix music tags", "clean metadata", "missing album artist", "beets import" | `Workflows/FixMetadata.md` |

## Quick Reference

- **Target structure:** `Artist/Year - Album/Track - Title.ext`
- **Most critical tag:** `ALBUM ARTIST` — missing = broken Navidrome grouping
- **Junk tags (TMED, TDOR, TSO2, SCRIPT):** harmless, skip removal unless over network (CIFS is too slow)
- **Various Artists:** all compilations go under `Various Artists/` with `album_artist = Various Artists`
- **DJ sets:** keep in main library with clean names, or move to `Singler/` for separation
- **beets:** MusicBrainz auto-tagging. Always use `-y` flag for non-interactive. `timid` + `quiet` conflict — don't combine.

**Full Documentation:**
- Navidrome specifics: `SkillSearch('navidrome')` → loads NavidromeGuide.md
- beets tips and pitfalls: `SkillSearch('beets')` → loads BeetsGuide.md
- Tool reference: see `Tools/`

## Key Learnings (from production sessions)

| Learning | Detail |
|----------|--------|
| Pre-flight check | Always verify write permissions before batch ops (especially CIFS) |
| Pattern-first scanning | Use regex on folder names before metadata reads — ffprobe over network is slow |
| beets interactive trap | `beet modify` needs `-y` in non-TTY sessions; `beet import` needs a real terminal |
| Same-name move bug | `os.rename("Artist", "Artist/Album")` fails — use temp rename pattern |
| Mutagen over ffmpeg | Use `mutagen` for tag writes (metadata-only, no re-encode) — 10x faster |
| Skippable fixes | TMED/TDOR/TSO2 don't affect Navidrome; COMMENT/ENCODED_BY is cosmetic only |

## Examples

**Example 1: Full library reorganization**
```
User: "Organize my music library for Navidrome at /mnt/music/Albums"
→ Invokes Reorganize workflow
→ Pattern-scans folder names for problems (scene releases, brackets, VA- prefix)
→ Creates Artist/Year - Album structure
→ Moves compilations to Various Artists/
→ Reports 119 changes, 1 conflict
```

**Example 2: Fix missing ALBUM ARTIST tags**
```
User: "My albums don't group by artist in Navidrome"
→ Invokes FixMetadata workflow
→ Uses beets with MusicBrainz for auto-tagging (~90% match rate)
→ Falls back to mutagen for remaining: extracts artist from folder path
→ Result: 930/935 albums now have ALBUM ARTIST
```
