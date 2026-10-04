#!/usr/bin/env bun

/**
 * PAI 2.0 to OpenCode Skill Migration Tool
 *
 * Copies PAI 2.0 skills to OpenCode format (no translation needed - identical format).
 * Counts tokens across three-tier progressive disclosure system.
 *
 * Usage:
 *   bun .opencode/tools/skill-migrate.ts --source path/to/skill --target .opencode/skills/SkillName
 *   bun .opencode/tools/skill-migrate.ts --source path/to/skill --target .opencode/skills/SkillName --dry-run
 *   bun .opencode/tools/skill-migrate.ts --source path/to/skill --target .opencode/skills/SkillName --force
 */

import { existsSync, statSync, readdirSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { parseArgs } from 'node:util';

interface TokenCounts {
  tier1: number;  // Description field
  tier2: number;  // SKILL.md body
  tier3: number;  // Reference files
}

interface MigrationOptions {
  source: string;
  target: string;
  dryRun: boolean;
  force: boolean;
}

function showHelp(): void {
  console.log(`
PAI 2.0 to OpenCode Skill Migration Tool

Usage:
  skill-migrate.ts --source <path> --target <path> [options]

Options:
  --source <path>   Source PAI 2.0 skill directory (required)
  --target <path>   Target OpenCode skill directory (required)
  --dry-run         Preview migration without copying files
  --force           Overwrite existing target directory
  --help            Show this help message

Examples:
  # Basic migration
  bun skill-migrate.ts --source ~/.claude/skills/CreateSkill --target .opencode/skills/CreateSkill

  # Dry run preview
  bun skill-migrate.ts --source ~/.claude/skills/CreateSkill --target .opencode/skills/CreateSkill --dry-run

  # Force overwrite
  bun skill-migrate.ts --source ~/.claude/skills/CreateSkill --target .opencode/skills/CreateSkill --force
`);
  process.exit(0);
}

function parseCliArgs(): MigrationOptions {
  try {
    const { values } = parseArgs({
      options: {
        source: { type: 'string' },
        target: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });

    if (values.help) {
      showHelp();
    }

    if (!values.source || !values.target) {
      console.error('❌ Error: Both --source and --target are required\n');
      showHelp();
    }

    return {
      source: values.source as string,
      target: values.target as string,
      dryRun: values['dry-run'] as boolean,
      force: values.force as boolean,
    };
  } catch (error) {
    console.error(`❌ Error parsing arguments: ${error}\n`);
    showHelp();
    process.exit(1);
  }
}

function validateSource(sourcePath: string): void {
  if (!existsSync(sourcePath)) {
    console.error(`❌ Error: Source directory does not exist: ${sourcePath}`);
    process.exit(1);
  }

  if (!statSync(sourcePath).isDirectory()) {
    console.error(`❌ Error: Source path is not a directory: ${sourcePath}`);
    process.exit(1);
  }

  const skillMdPath = join(sourcePath, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    console.error(`❌ Error: SKILL.md not found in source directory: ${sourcePath}`);
    process.exit(1);
  }
}

function validateTarget(targetPath: string, force: boolean): void {
  if (existsSync(targetPath) && !force) {
    console.error(`❌ Error: Target directory already exists: ${targetPath}`);
    console.error('   Use --force to overwrite or choose a different target');
    process.exit(1);
  }
}

function extractYamlFrontmatter(content: string): { frontmatter: string; body: string } {
  const yamlRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(yamlRegex);

  if (!match) {
    return { frontmatter: '', body: content };
  }

  return {
    frontmatter: match[1],
    body: match[2],
  };
}

function extractDescription(frontmatter: string): string {
  const descMatch = frontmatter.match(/description:\s*(.+?)(?:\n[a-z]|$)/s);
  return descMatch ? descMatch[1].trim() : '';
}

function countTokens(text: string): number {
  // 4 characters ≈ 1 token
  return Math.ceil(text.length / 4);
}

function calculateTokenCounts(sourcePath: string): TokenCounts {
  const skillMdPath = join(sourcePath, 'SKILL.md');
  const skillContent = readFileSync(skillMdPath, 'utf-8');

  const { frontmatter, body } = extractYamlFrontmatter(skillContent);
  const description = extractDescription(frontmatter);

  // Tier 1: Description field
  const tier1 = countTokens(description);

  // Tier 2: SKILL.md body (after frontmatter)
  const tier2 = countTokens(body);

  // Tier 3: All other .md files
  let tier3 = 0;
  const allFiles = getAllFiles(sourcePath);
  for (const file of allFiles) {
    if (file.endsWith('.md') && !file.endsWith('SKILL.md')) {
      const content = readFileSync(file, 'utf-8');
      tier3 += countTokens(content);
    }
  }

  return { tier1, tier2, tier3 };
}

function getAllFiles(dirPath: string, fileList: string[] = []): string[] {
  const files = readdirSync(dirPath);

  for (const file of files) {
    // Skip hidden files like .DS_Store
    if (file.startsWith('.')) continue;

    const filePath = join(dirPath, file);
    const stat = statSync(filePath);

    if (stat.isDirectory()) {
      getAllFiles(filePath, fileList);
    } else {
      fileList.push(filePath);
    }
  }

  return fileList;
}

function copyDirectory(source: string, target: string, dryRun: boolean): number {
  let fileCount = 0;
  const files = getAllFiles(source);

  if (!dryRun) {
    // Create target directory if it doesn't exist
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }
  }

  for (const sourceFile of files) {
    const relativePath = sourceFile.substring(source.length + 1);
    const targetFile = join(target, relativePath);
    const targetDir = dirname(targetFile);

    if (!dryRun) {
      // Create subdirectories as needed
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      // Copy file
      copyFileSync(sourceFile, targetFile);
    }

    fileCount++;
  }

  return fileCount;
}

function displayFileTree(sourcePath: string): void {
  const files = getAllFiles(sourcePath);
  const relativePaths = files.map(f => f.substring(sourcePath.length + 1));

  for (const file of relativePaths) {
    console.log(`│   ├── ${file} ✓`);
  }
}

function main(): void {
  const options = parseCliArgs();

  // Validate source
  validateSource(options.source);

  // Validate target (unless dry run)
  if (!options.dryRun) {
    validateTarget(options.target, options.force);
  }

  const skillName = basename(options.target);

  console.log(`\nMigrating PAI 2.0 skill: ${skillName}`);
  console.log(`├── Source: ${options.source}`);
  console.log(`├── Target: ${options.target}`);

  if (options.dryRun) {
    console.log(`├── Mode: DRY RUN (no files will be copied)`);
  }

  // Calculate token counts
  const tokens = calculateTokenCounts(options.source);

  // Copy files (or simulate in dry run)
  console.log(`├── ${options.dryRun ? 'Files to copy' : 'Copying files'}...`);
  displayFileTree(options.source);

  const fileCount = copyDirectory(options.source, options.target, options.dryRun);

  // Display token breakdown
  console.log(`└── Token count estimation:`);
  console.log(`    ├── Tier 1 (description): ~${tokens.tier1} tokens`);
  console.log(`    ├── Tier 2 (SKILL.md body): ~${tokens.tier2} tokens`);
  console.log(`    └── Tier 3 (reference files): ~${tokens.tier3} tokens (lazy loaded)`);

  console.log('');

  if (options.dryRun) {
    console.log(`✓ Dry run complete! ${fileCount} files would be copied.`);
    console.log(`  Run without --dry-run to perform actual migration.`);
  } else {
    console.log(`✓ Migration complete! ${fileCount} files copied.`);
  }
}

main();
