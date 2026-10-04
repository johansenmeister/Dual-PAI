#!/usr/bin/env bun

/**
 * RebuildPAI.ts - Assembles SKILL.md from Components/
 *
 * Usage: bun ~/.opencode/PAI/Tools/RebuildPAI.ts
 *
 * Reads all .md files from Components/, sorts by numeric prefix,
 * concatenates them, and writes to SKILL.md with build timestamp
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Validate home directory
const HOME = homedir() || process.env.HOME;
if (!HOME) {
  console.error("❌ Error: Cannot determine home directory");
  process.exit(1);
}

// Use .opencode/ paths (correct for PAI-OpenCode)
const PAI_DIR = join(HOME, ".opencode/PAI");
const COMPONENTS_DIR = join(PAI_DIR, "Components");
const ALGORITHM_DIR = join(PAI_DIR, "Algorithm");
const OUTPUT_FILE = join(PAI_DIR, "SKILL.md");
const SETTINGS_PATH = join(HOME, ".opencode/settings.json");

/**
 * Load identity variables from settings.json for template resolution
 */
function loadVariables(): Record<string, string> {
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return {
      "{DAIDENTITY.NAME}": settings.daidentity?.name || "PAI",
      "{DAIDENTITY.FULLNAME}": settings.daidentity?.fullName || "Personal AI",
      "{DAIDENTITY.DISPLAYNAME}": settings.daidentity?.displayName || "PAI",
      "{PRINCIPAL.NAME}": settings.principal?.name || "User",
      "{PRINCIPAL.TIMEZONE}": settings.principal?.timezone || "UTC",
    };
  } catch {
    console.warn("⚠️ Could not read settings.json, using defaults");
    return {
      "{DAIDENTITY.NAME}": "PAI",
      "{DAIDENTITY.FULLNAME}": "Personal AI",
      "{DAIDENTITY.DISPLAYNAME}": "PAI",
      "{PRINCIPAL.NAME}": "User",
      "{PRINCIPAL.TIMEZONE}": "UTC",
    };
  }
}

/**
 * Resolve template variables in content
 */
function resolveVariables(content: string, variables: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

// Generate timestamp in format: DAY MONTH YEAR HOUR MINUTE SECOND
function getTimestamp(): string {
  const now = new Date();
  const day = now.getDate();
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  const hour = now.getHours().toString().padStart(2, '0');
  const minute = now.getMinutes().toString().padStart(2, '0');
  const second = now.getSeconds().toString().padStart(2, '0');

  return `${day} ${month} ${year} ${hour}:${minute}:${second}`;
}

// Load versioned algorithm
function loadAlgorithm(): string {
  const latestFile = join(ALGORITHM_DIR, "LATEST");
  
  if (!existsSync(latestFile)) {
    throw new Error(`LATEST file not found: ${latestFile}`);
  }
  
  let version = readFileSync(latestFile, "utf-8").trim();
  // Remove .md extension if present to avoid "v3.7.0.md.md"
  version = version.replace(/\.md$/i, '');
  
  const algorithmFile = join(ALGORITHM_DIR, `${version}.md`);
  
  if (!existsSync(algorithmFile)) {
    throw new Error(`Algorithm file not found: ${algorithmFile} (version: ${version})`);
  }
  
  return readFileSync(algorithmFile, "utf-8");
}

// Get all .md files, sorted by numeric prefix
// Check COMPONENTS_DIR exists
if (!existsSync(COMPONENTS_DIR)) {
  console.error(`❌ Error: Components directory not found: ${COMPONENTS_DIR}`);
  console.error("   Make sure the directory exists and contains component .md files");
  process.exit(1);
}

const components = readdirSync(COMPONENTS_DIR)
  .filter(f => f.endsWith(".md"))
  .sort((a, b) => {
    const numA = parseInt(a.split("-")[0], 10) || 0;
    const numB = parseInt(b.split("-")[0], 10) || 0;
    return numA - numB;
  });

if (components.length === 0) {
  console.error("❌ No component files found in Components/");
  process.exit(1);
}

// Assemble content
let output = "";
const timestamp = getTimestamp();
const algorithmContent = loadAlgorithm();

for (const file of components) {
  let content = readFileSync(join(COMPONENTS_DIR, file), "utf-8");

  // Inject timestamp into frontmatter component (robust with regex fallback)
  if (file === "00-frontmatter.md") {
    // Try to find and replace Build: line, add Built: after it
    const buildMatch = content.match(/(Build:\s*[^\n]+)/);
    if (buildMatch) {
      content = content.replace(
        buildMatch[0],
        `${buildMatch[0]}\n  Built:  ${timestamp}`
      );
    } else {
      // Fallback: warn if pattern not found
      console.warn("⚠️  Could not find 'Build:' line in 00-frontmatter.md, skipping timestamp injection");
    }
    // Update path references to use .opencode
    content = content.replace(/~\/\.claude\/PAI/g, "~/.opencode/PAI");
  }

  // Inject versioned algorithm (global replace for all occurrences)
  if (content.includes("{{ALGORITHM_VERSION}}")) {
    // Use replaceAll for global replacement, fallback to split/join for older runtimes
    content = content.replaceAll("{{ALGORITHM_VERSION}}", algorithmContent);
  }

  output += content;

  // No extra newlines - components manage their own spacing
}

// Resolve template variables from settings.json
const variables = loadVariables();
output = resolveVariables(output, variables);

// Write output
writeFileSync(OUTPUT_FILE, output);

console.log(`✅ Built SKILL.md from ${components.length} components:`);
components.forEach((c, i) => {
  console.log(`   ${(i + 1).toString().padStart(2)}. ${c}`);
});
console.log(`\n🔄 Resolved ${Object.keys(variables).length} template variables:`);
for (const [key, value] of Object.entries(variables)) {
  console.log(`   ${key} → ${value}`);
}
console.log(`\n📄 Output: ${OUTPUT_FILE}`);
