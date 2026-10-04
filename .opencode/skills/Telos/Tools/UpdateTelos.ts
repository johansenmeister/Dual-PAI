#!/usr/bin/env bun
/**
 * update-telos - Update TELOS life context with automatic backups and change tracking
 *
 * This command manages updates to the TELOS life context files, ensuring:
 * - Automatic timestamped backups before any modification
 * - Change tracking in updates.md
 * - Complete version history
 *
 * Usage:
 *   update-telos <file> "<content>" "<change-description>"
 *
 * Example:
 *   update-telos BOOKS.md "- Project Hail Mary by Andy Weir" "Added new favorite book"
 *
 * Files that can be updated:
 * - BELIEFS.md - Core beliefs and world model
 * - BOOKS.md - Favorite books
 * - CHALLENGES.md - Current challenges
 * - FRAMES.md - Mental frames and perspectives
 * - GOALS.md - Life goals
 * - LESSONS.md - Lessons learned
 * - MISSION.md - Life mission
 * - MODELS.md - Mental models
 * - MOVIES.md - Favorite movies
 * - NARRATIVES.md - Personal narratives
 * - PREDICTIONS.md - Predictions about the future
 * - PROBLEMS.md - Problems to solve
 * - PROJECTS.md - Active projects
 * - STRATEGIES.md - Strategies being employed
 * - TELOS.md - Main TELOS document
 * - TRAUMAS.md - Past traumas
 * - WISDOM.md - Accumulated wisdom
 * - WRONG.md - Things I was wrong about
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getPrincipal } from '../../../pai-core/lib/identity';
import { getHomePaiDir } from '../../../pai-core/lib/paths';
import { getLocalTimestamp } from '../../../pai-core/lib/time';

const TELOS_DIR = join(getHomePaiDir(), 'PAI', 'USER', 'TELOS');
const BACKUPS_DIR = join(TELOS_DIR, 'backups');
const UPDATES_FILE = join(TELOS_DIR, 'updates.md');

// Valid TELOS files
const VALID_FILES = [
  'BELIEFS.md', 'BOOKS.md', 'CHALLENGES.md', 'FRAMES.md', 'GOALS.md',
  'LESSONS.md', 'MISSION.md', 'MODELS.md', 'MOVIES.md', 'NARRATIVES.md',
  'PREDICTIONS.md', 'PROBLEMS.md', 'PROJECTS.md', 'STRATEGIES.md',
  'TELOS.md', 'TRAUMAS.md', 'WISDOM.md', 'WRONG.md'
];

/**
 * Both stamps come from `getLocalTimestamp()`, in the configured zone.
 *
 * These were a third copy of the idiom from M-25:
 * `new Date(now.toLocaleString('en-US', { timeZone }))` re-parses the
 * formatted text as machine-local time, so the stamp was right only when
 * the machine sat in `principal.timezone`, and the log line said "PT"
 * whatever the zone was.
 */
function getBackupTimestamp(): string {
  return getLocalTimestamp().replace(/-|:/g, '').replace('T', '-');
}

function getDateForLog(): string {
  return `${getLocalTimestamp().replace('T', ' ')} ${getPrincipal().timezone || 'UTC'}`;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('❌ Usage: update-telos <file> "<content>" "<change-description>"');
    console.error('\nExample: update-telos BOOKS.md "- New Book Title" "Added favorite book"');
    console.error('\nValid files:', VALID_FILES.join(', '));
    process.exit(1);
  }

  const [filename, content, changeDescription] = args;

  // Validate filename
  if (!VALID_FILES.includes(filename)) {
    console.error(`❌ Invalid file: ${filename}`);
    console.error(`Valid files: ${VALID_FILES.join(', ')}`);
    process.exit(1);
  }

  const targetFile = join(TELOS_DIR, filename);

  // Check if file exists
  if (!existsSync(targetFile)) {
    console.error(`❌ File does not exist: ${targetFile}`);
    process.exit(1);
  }

  // Step 1: Create timestamped backup
  const timestamp = getBackupTimestamp();
  const backupFilename = filename.replace('.md', `-${timestamp}.md`);
  const backupPath = join(BACKUPS_DIR, backupFilename);

  try {
    if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
    copyFileSync(targetFile, backupPath);
    console.log(`✅ Backup created: ${backupFilename}`);
  } catch (error) {
    console.error(`❌ Failed to create backup: ${error}`);
    process.exit(1);
  }

  // Step 2: Update the target file (append content)
  try {
    const currentContent = readFileSync(targetFile, 'utf-8');
    const updatedContent = currentContent.trimEnd() + '\n' + content + '\n';
    writeFileSync(targetFile, updatedContent, 'utf-8');
    console.log(`✅ Updated: ${filename}`);
  } catch (error) {
    console.error(`❌ Failed to update file: ${error}`);
    process.exit(1);
  }

  // Step 3: Update updates.md with change log
  try {
    const logTimestamp = getDateForLog();
    const logEntry = `
## ${logTimestamp}

- **File Modified**: ${filename}
- **Change Type**: Content Addition
- **Description**: ${changeDescription}
- **Backup Location**: \`backups/${backupFilename}\`

`;

    if (!existsSync(UPDATES_FILE)) {
      writeFileSync(UPDATES_FILE, '# TELOS Update Log\n\n## Future Changes\n\nDocument all changes below in reverse-chronological order.\n\n', 'utf-8');
    }
    const updatesContent = readFileSync(UPDATES_FILE, 'utf-8');

    // Insert the new entry after "## Future Changes" section
    const futureChangesMarker = '## Future Changes';
    const insertPosition = updatesContent.indexOf(futureChangesMarker);

    if (insertPosition !== -1) {
      const beforeMarker = updatesContent.substring(0, insertPosition + futureChangesMarker.length);
      const afterMarker = updatesContent.substring(insertPosition + futureChangesMarker.length);

      // Find the end of the "Document all changes below..." line
      const nextLineBreak = afterMarker.indexOf('\n');
      const headerSection = afterMarker.substring(0, nextLineBreak + 1);
      const changesList = afterMarker.substring(nextLineBreak + 1);

      const updatedUpdates = beforeMarker + headerSection + logEntry + changesList;
      writeFileSync(UPDATES_FILE, updatedUpdates, 'utf-8');
      console.log(`✅ Change logged in updates.md`);
    } else {
      // Fallback: just append
      const updatedUpdates = updatesContent.trimEnd() + '\n' + logEntry;
      writeFileSync(UPDATES_FILE, updatedUpdates, 'utf-8');
      console.log(`✅ Change logged in updates.md (appended)`);
    }
  } catch (error) {
    console.error(`❌ Failed to update updates.md: ${error}`);
    process.exit(1);
  }

  console.log('\n🎯 TELOS update complete!');
  console.log(`   File: ${filename}`);
  console.log(`   Backup: backups/${backupFilename}`);
  console.log(`   Change: ${changeDescription}`);
}

main();
