# Reorganize Workflow

Reorganize music library folders to `Artist/Year - Album` structure for Navidrome.

## Notification

Running **Reorganize** in **MusicLibrary**...

## Step 1: Pre-Flight Check

```bash
# Verify write access
touch /path/to/library/.write_test && rm /path/to/library/.write_test

# Check mount type (CIFS = slow, ZFS local = fast)
mount | grep "$(df /path/to/library | tail -1 | awk '{print $1}')"
```

## Step 2: Pattern-Based Scan

Do NOT use ffprobe for initial scan — too slow over network. Use regex on folder names first:

```python
# Categories to detect (in order):
# 1. -= ... =- wrapping        → rename to plain artist name
# 2. VA- prefix compilations    → move to Various Artists/
# 3. [...] bracket prefix       → remove brackets
# 4. Scene releases (WEB-/CD-YYYY-) → parse artist+album, check year via ffprobe
# 5. Year in parentheses (YYYY) → extract year, remove from name
# 6. DJ sets (B2B, SAT-YYYY, DJ prefix) → clean names
# 7. Mixed underscores+dashes   → normalize to "Artist - Album"
# 8. Single-word folders        → artist folder (check for sub-albums)
# 9. "Artist - Album" format    → already OK, just move to Artist/Year-Album
```

## Step 3: Metadata Lookup (Selective)

Only use ffprobe on folders that actually need it (scene releases, unknown albums):
```bash
ffprobe -v quiet -print_format json -show_format "file.mp3"
```

## Step 4: Execute Changes

**Always run dry-run first:**
```bash
python3 reorganize.py --dry-run
```

**Order matters:** Move loose files to Singler/ FIRST, then rename/move folders:
1. Loose files → Singler/Div
2. -= ... =- wrapping removal
3. [...] brackets removal
4. Scene releases → Artist/Year - Album
5. VA compilations → Various Artists/
6. Unknown → Singler/Div

## Step 5: Handle Same-Name Bug

When artist folder name matches the source folder name:
```python
# WRONG: os.rename("Artist", "Artist/2000 - Album")  # "Cannot move into itself"
# RIGHT:
os.rename("Artist", "__TEMP_Artist__")
os.makedirs("Artist")
os.rename("__TEMP_Artist__", "Artist/2000 - Album")
```

## Verification

```bash
# Check no -= ... =- remain
ls /path/to/library/-=* 2>/dev/null | wc -l   # Should be 0

# Check no VA- remain at root
ls /path/to/library/VA-* 2>/dev/null | wc -l  # Should be 0

# Check Various Artists populated
ls "/path/to/library/Various Artists/" | wc -l
```
