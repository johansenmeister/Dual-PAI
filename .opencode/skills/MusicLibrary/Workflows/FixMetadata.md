# FixMetadata Workflow

Fix music metadata tags for Navidrome using beets + MusicBrainz + mutagen fallback.

## Notification

Running **FixMetadata** in **MusicLibrary**...

## Step 1: Install Tools

```bash
# beets for MusicBrainz auto-tagging
sudo apt install -y beets python3-pip

# mutagen for fast targeted tag writes (no re-encode)
pip3 install mutagen --break-system-packages
```

## Step 2: Configure Beets

Create `~/.config/beets/config.yaml`:
```yaml
directory: /path/to/music
library: ~/.config/beets/library.db
import:
    copy: no
    move: no
    write: yes
    autotag: yes
```

**CRITICAL:** Do NOT set `timid: yes` — it conflicts with `-q` flag.

## Step 3: Run Beets Import (requires real terminal!)

```bash
# Interactive — user presses A/S/U at prompts
beet import -A /path/to/library

# Keys:
#   A = Apply this match (use most often)
#   S = Skip this album
#   U = Use existing tags as-is
#   1/2/3 = Choose different MusicBrainz candidate
```

**Cannot run in non-TTY sessions.** User must execute in their own terminal.

## Step 4: Audit Results

```bash
# What's fixed
beet stats

# What still lacks ALBUM ARTIST
beet ls -a 'albumartist::^$'

# What didn't match MusicBrainz
beet ls -a 'mb_albumid::^$'
```

## Step 5: Mutagen Fallback

For albums beets couldn't match (obscure Norwegian, DJ sets, bootlegs):

```python
from mutagen.mp3 import EasyMP3
from mutagen.flac import FLAC
import os

# Extract artist from folder path
for path in missing_albums:
    artist = path.split('/')[0]  # First path component = artist
    for f in music_files_in(path):
        audio = EasyMP3(f) if f.endswith('.mp3') else FLAC(f)
        if not audio.get('albumartist'):
            audio['albumartist'] = artist
            audio.save()
```

## Step 6: Fix Various Artists/Diverse

For large catch-all folders:
```bash
# Use beets with -y flag
beet modify -ay albumartist='Various Artists' 'path::Diverse'
```

## What to Skip

| Operation | Reason |
|-----------|--------|
| Remove TMED/TDOR/TSO2/SCRIPT tags | Don't affect Navidrome; too slow over CIFS |
| Clean COMMENT/ENCODED_BY | Cosmetic only; Navidrome ignores them |
| `beet update` over network | Timeout — reads all 16k+ files from scratch |
| Fix YEAR on unmatched albums | MusicBrainz can't help; accept 0000 |
