# Beets Guide

beets-specific configuration, commands, and pitfalls learned in production.

## Installation

```bash
# Preferred: system package (stable)
sudo apt install -y beets python3-pip

# Alternative: pipx (newer version)
pipx install beets

# Required for fast tag writing (no re-encode)
pip3 install mutagen --break-system-packages
```

## Minimal Config (`~/.config/beets/config.yaml`)

```yaml
directory: /path/to/music
library: ~/.config/beets/library.db

import:
    copy: no          # Files already in place — don't copy
    move: no          # Don't reorganize files
    write: yes        # Write metadata tags to files
    resume: ask
    autotag: yes      # Use MusicBrainz matching

paths:
    default: $albumartist/$year - $album/$track $title
    singleton: Singlers/$artist - $title
    comp: Various Artists/$year - $album/$track $title
```

## Key Commands

### Import (auto-tag from MusicBrainz)
```bash
# Full auto-import (accepts good matches, requires terminal for bad ones)
beet import -A /path/to/library

# Non-interactive (for headless/scripted — risky!)
beet import -Aq /path/to/library

# Pretend mode (show what WOULD happen)
beet import -Ap /path/to/one/album
```

### Modify Tags
```bash
# ALWAYS use -y flag for non-interactive sessions!
beet modify -ay albumartist='Artist Name' 'path::/Artist/'
beet modify -ay comment='' 'comment::.*'

# Clear encoded_by
beet modify -ay encoded_by=''
```

### Query
```bash
# Albums missing ALBUM ARTIST
beet ls -a 'albumartist::^$'

# Albums without MusicBrainz match
beet ls -a 'mb_albumid::^$'

# Albums by path
beet ls -a 'path::SomeArtist'

# Stats
beet stats
```

## Pitfalls Learned (Production)

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| `timid: yes` + `-q` flag | `error: can't be both quiet and timid` | Remove `timid` from config |
| `beet modify` without `-y` | `error: stdin stream ended while input required` | Add `-y` flag |
| `beet import` in non-TTY | Can't answer interactive prompts | User must run in terminal |
| `clutter` config doesn't strip tags | TMED/TDOR still present after import | Use ffmpeg or mutagen separately |
| Over CIFS: modify on 16k tracks | Timeout after 2+ minutes | Use mutagen for targeted fixes, not batch modify |
| `beet update` over CIFS | Timeout — re-reads all files | Skip — Navidrome reads file tags, not beets DB |

## Mutagen Quick Reference

For fast, targeted tag writes without beets overhead:

```python
from mutagen.mp3 import EasyMP3
from mutagen.flac import FLAC

# MP3
audio = EasyMP3("file.mp3")
audio['albumartist'] = 'Artist Name'
audio.save()

# FLAC
audio = FLAC("file.flac")
audio['albumartist'] = 'Artist Name'
audio.save()
```

**Mutagen vs ffmpeg:** Mutagen writes metadata only (~10ms/file). ffmpeg re-encodes the stream (~500ms/file). Always prefer mutagen for tag-only changes.
