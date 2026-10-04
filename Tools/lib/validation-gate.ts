/**
 * Validation Gate System for PAI-OpenCode Converter
 *
 * Provides risk analysis and user decision points for system-critical files.
 * Prevents accidental overwrites of customized PAI infrastructure.
 */

import { readFileSync, existsSync } from "node:fs";
import { diffLines } from "diff";

// ============================================================================
// TYPES
// ============================================================================

export interface SystemFile {
  path: string;
  category: "skill" | "plugin" | "config" | "tool";
  importance: "critical" | "high" | "medium";
}

export interface FileComparison {
  source: { path: string; lines: number; version?: string };
  target: { path: string; lines: number; version?: string };
  diff: { added: number; removed: number; changed: number };
  structureCompatible: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
  recommendation: "overwrite" | "keep" | "merge" | "review";
}

export interface ValidationGateResult {
  file: SystemFile;
  comparison: FileComparison;
  userChoice?: "overwrite" | "keep" | "merge" | "defer";
  timestamp: string;
}

// ============================================================================
// SYSTEM FILES REGISTRY
// ============================================================================

export const SYSTEM_FILES: SystemFile[] = [
  { path: "skills/System/", category: "skill", importance: "critical" },
  { path: "skills/CORE/", category: "skill", importance: "critical" },
  { path: "plugins/pai-unified.ts", category: "plugin", importance: "critical" },
  { path: "pai-core/adapters/", category: "plugin", importance: "high" },
  { path: "pai-core/handlers/", category: "plugin", importance: "high" },
  { path: "pai-core/lib/", category: "plugin", importance: "medium" },
  { path: "Tools/MigrationValidator.ts", category: "tool", importance: "high" },
  { path: "config/settings.json", category: "config", importance: "critical" },
  { path: "hooks/", category: "plugin", importance: "high" },
];

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Check if a file path matches a system file pattern
 */
export function isSystemFile(path: string): SystemFile | null {
  for (const systemFile of SYSTEM_FILES) {
    // Handle directory patterns (ending with /)
    if (systemFile.path.endsWith("/")) {
      if (path.startsWith(systemFile.path)) {
        return systemFile;
      }
    } else {
      // Exact file match
      if (path === systemFile.path || path.endsWith(`/${systemFile.path}`)) {
        return systemFile;
      }
    }
  }
  return null;
}

/**
 * Compare two files and analyze differences
 */
export function compareFiles(
  sourcePath: string,
  targetPath: string
): FileComparison {
  // Check if files exist
  const sourceExists = existsSync(sourcePath);
  const targetExists = existsSync(targetPath);

  if (!sourceExists && !targetExists) {
    throw new Error(`Neither source nor target file exists: ${sourcePath}`);
  }

  // Read file contents
  const sourceContent = sourceExists ? readFileSync(sourcePath, "utf-8") : "";
  const targetContent = targetExists ? readFileSync(targetPath, "utf-8") : "";

  // Count lines
  const sourceLines = sourceContent.split("\n").length;
  const targetLines = targetContent.split("\n").length;

  // Extract versions if present
  const sourceVersion = extractVersion(sourceContent);
  const targetVersion = extractVersion(targetContent);

  // Calculate diff
  const diffResult = diffLines(sourceContent, targetContent);
  let added = 0;
  let removed = 0;
  let changed = 0;

  diffResult.forEach((part) => {
    const lineCount = part.count || 0;
    if (part.added) {
      added += lineCount;
    } else if (part.removed) {
      removed += lineCount;
    } else {
      // Unchanged lines don't contribute to changed count
    }
  });

  // Changed is the total modifications
  changed = added + removed;

  // Check structure compatibility
  const structureCompatible = checkStructureCompatibility(
    sourceContent,
    targetContent
  );

  // Build initial comparison
  const comparison: FileComparison = {
    source: { path: sourcePath, lines: sourceLines, version: sourceVersion },
    target: { path: targetPath, lines: targetLines, version: targetVersion },
    diff: { added, removed, changed },
    structureCompatible,
    riskLevel: "low", // Will be set by analyzeRisk
    recommendation: "review", // Will be set by analyzeRisk
  };

  // Analyze risk and get recommendation
  return analyzeRisk(comparison);
}

/**
 * Analyze risk level based on file comparison
 */
export function analyzeRisk(comparison: FileComparison): FileComparison {
  const { source, target, diff, structureCompatible } = comparison;

  // Calculate change percentage
  const totalLines = Math.max(source.lines, target.lines);
  const changePercent = totalLines > 0 ? (diff.changed / totalLines) * 100 : 0;

  // Determine risk level
  let riskLevel: FileComparison["riskLevel"] = "low";
  let recommendation: FileComparison["recommendation"] = "overwrite";

  // CRITICAL: Structure incompatible
  if (!structureCompatible) {
    riskLevel = "critical";
    recommendation = "review";
  }
  // HIGH: More than 30% changes
  else if (changePercent > 30) {
    riskLevel = "high";
    recommendation = "merge";
  }
  // MEDIUM: Between 10-30% changes
  else if (changePercent > 10) {
    riskLevel = "medium";
    recommendation = "review";
  }
  // LOW: Small updates
  else {
    riskLevel = "low";
    // Check version comparison for recommendation
    if (target.version && source.version) {
      if (compareVersions(target.version, source.version) > 0) {
        recommendation = "keep"; // Target is newer
      } else {
        recommendation = "overwrite"; // Source is newer or same
      }
    } else {
      recommendation = "overwrite";
    }
  }

  // Detect custom code patterns
  if (hasCustomCode(target.path)) {
    riskLevel = riskLevel === "low" ? "medium" : riskLevel;
    recommendation = "merge";
  }

  return {
    ...comparison,
    riskLevel,
    recommendation,
  };
}

/**
 * Format validation gate for CLI display
 */
export function formatValidationGate(comparison: FileComparison): string {
  const { source, target, diff, riskLevel, recommendation } = comparison;

  const riskColors = {
    low: "🟢",
    medium: "🟡",
    high: "🟠",
    critical: "🔴",
  };

  const lines: string[] = [];
  lines.push("");
  lines.push("╔═══════════════════════════════════════════════════════════╗");
  lines.push("║         VALIDATION GATE - SYSTEM FILE DETECTED           ║");
  lines.push("╚═══════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`${riskColors[riskLevel]} RISK LEVEL: ${riskLevel.toUpperCase()}`);
  lines.push("");
  lines.push("FILE COMPARISON:");
  lines.push(`  Source: ${source.path}`);
  lines.push(`    Lines: ${source.lines}${source.version ? ` | Version: ${source.version}` : ""}`);
  lines.push(`  Target: ${target.path}`);
  lines.push(`    Lines: ${target.lines}${target.version ? ` | Version: ${target.version}` : ""}`);
  lines.push("");
  lines.push("CHANGES:");
  lines.push(`  Added:   ${diff.added} lines`);
  lines.push(`  Removed: ${diff.removed} lines`);
  lines.push(`  Total:   ${diff.changed} lines changed`);
  lines.push("");
  lines.push(`RECOMMENDED ACTION: ${recommendation.toUpperCase()}`);
  lines.push("");
  lines.push("OPTIONS:");
  lines.push("  [O] Overwrite - Replace target with source");
  lines.push("  [K] Keep      - Keep current target, skip source");
  lines.push("  [M] Merge     - Show diff for manual merge");
  lines.push("  [D] Defer     - Decide later");
  lines.push("");
  lines.push("───────────────────────────────────────────────────────────");

  return lines.join("\n");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract version from file content
 * Looks for patterns like: version: "1.0.0" or @version 1.0.0
 */
function extractVersion(content: string): string | undefined {
  const versionPatterns = [
    /version[:\s]+["']?([0-9]+\.[0-9]+\.[0-9]+)["']?/i,
    /@version\s+([0-9]+\.[0-9]+\.[0-9]+)/i,
    /v([0-9]+\.[0-9]+\.[0-9]+)/i,
  ];

  for (const pattern of versionPatterns) {
    const match = content.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Compare two semantic versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }

  return 0;
}

/**
 * Check if two files have compatible structure
 * Compares exported functions, classes, and major code blocks
 */
function checkStructureCompatibility(
  content1: string,
  content2: string
): boolean {
  // Extract exports from both files
  const exports1 = extractExports(content1);
  const exports2 = extractExports(content2);

  // If one file has exports and the other doesn't, incompatible
  if (exports1.length > 0 && exports2.length === 0) return false;
  if (exports2.length > 0 && exports1.length === 0) return false;

  // If both have exports, check for major differences
  if (exports1.length > 0 && exports2.length > 0) {
    const missing = exports1.filter((exp) => !exports2.includes(exp));
    // If more than 30% of exports are missing, incompatible
    if (missing.length / exports1.length > 0.3) return false;
  }

  return true;
}

/**
 * Extract export names from TypeScript/JavaScript code
 */
function extractExports(content: string): string[] {
  const exports: string[] = [];
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      exports.push(match[1]);
    }
  }

  return exports;
}

/**
 * Detect if target file contains custom code patterns
 * Looks for comments like "CUSTOM", "USER", or specific naming patterns
 */
function hasCustomCode(filePath: string): boolean {
  if (!existsSync(filePath)) return false;

  const content = readFileSync(filePath, "utf-8");
  const customPatterns = [
    /\/\/\s*CUSTOM/i,
    /\/\/\s*USER/i,
    /\/\*\s*CUSTOM/i,
    /\/\*\s*USER/i,
    /#\s*CUSTOM/i,
    /#\s*USER/i,
    /steffen|jeremy/i, // Engineer and DA names
  ];

  return customPatterns.some((pattern) => pattern.test(content));
}

// ============================================================================
// VALIDATION GATE EXECUTION
// ============================================================================

/**
 * Create a validation gate result with timestamp
 */
export function createValidationGateResult(
  systemFile: SystemFile,
  comparison: FileComparison,
  userChoice?: ValidationGateResult["userChoice"]
): ValidationGateResult {
  return {
    file: systemFile,
    comparison,
    userChoice,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Log validation gate result to file
 */
export function logValidationGate(
  result: ValidationGateResult,
  logPath: string
): void {
  const log = `${JSON.stringify(result, null, 2)}\n`;
  const { appendFileSync } = require("node:fs");
  appendFileSync(logPath, log);
}
