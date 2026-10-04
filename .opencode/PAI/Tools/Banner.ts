#!/usr/bin/env bun

/**
 * Dual PAI Banner - the splash screen `pai` shows before the engine starts
 *
 * One Navy design, compacted by terminal width (85+, 70+, 55+, 45+, smaller).
 * `--engine=claude|opencode` says which engine is starting (the launcher passes
 * it); `--design=<name>` forces a layout, `--test` prints all of them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir, hostname } from "node:os";

const HOME = homedir();
const CLAUDE_DIR = process.env.OPENCODE_DIR || join(HOME, ".opencode");

// Prosjektet, ikke installasjonen: det samme i alle repoene. Det som er
// brukerens (DA-navnet, frasen, repoadressen), leses fra settings.json.
const PROJECT = "Dual PAI";
const TAGLINE = "One PAI, two engines, one memory";
const AUTHOR = "johansenmeister";
const CREDIT = "built on PAI by Daniel Miessler, from pai-opencode by Steffen025";

// ═══════════════════════════════════════════════════════════════════════════
// Terminal Width Detection
// ═══════════════════════════════════════════════════════════════════════════

function getTerminalWidth(): number {
  let width: number | null = null;

  const kittyWindowId = process.env.KITTY_WINDOW_ID;
  if (kittyWindowId) {
    try {
      const result = spawnSync("kitten", ["@", "ls"], { encoding: "utf-8" });
      if (result.stdout) {
        const data = JSON.parse(result.stdout);
        for (const osWindow of data) {
          for (const tab of osWindow.tabs) {
            for (const win of tab.windows) {
              if (win.id === parseInt(kittyWindowId, 10)) {
                width = win.columns;
                break;
              }
            }
          }
        }
      }
    } catch {}
  }

  if (!width || width <= 0) {
    try {
      const result = spawnSync("sh", ["-c", "stty size </dev/tty 2>/dev/null"], { encoding: "utf-8" });
      if (result.stdout) {
        const cols = parseInt(result.stdout.trim().split(/\s+/)[1], 10);
        if (cols > 0) width = cols;
      }
    } catch {}
  }

  if (!width || width <= 0) {
    try {
      const result = spawnSync("tput", ["cols"], { encoding: "utf-8" });
      if (result.stdout) {
        const cols = parseInt(result.stdout.trim(), 10);
        if (cols > 0) width = cols;
      }
    } catch {}
  }

  if (!width || width <= 0) {
    width = parseInt(process.env.COLUMNS || "100", 10) || 100;
  }

  return width;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANSI Helpers
// ═══════════════════════════════════════════════════════════════════════════

const RESET = "\x1b[0m";
const ITALIC = "\x1b[3m";

const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

// Box drawing
const BOX = {
  tl: "\u256d", tr: "\u256e", bl: "\u2570", br: "\u256f",
  h: "\u2500", v: "\u2502", dh: "\u2550",
};

// ═══════════════════════════════════════════════════════════════════════════
// Stats Collection
// ═══════════════════════════════════════════════════════════════════════════

interface SystemStats {
  name: string;
  catchphrase: string;
  repoUrl: string;
  skills: number;
  workflows: number;
  learnings: number;
  userFiles: number;
  /** Motoren som starter, med versjon: «OpenCode 2.0.22» eller «Claude Code 2.1.283». */
  engine: string;
  host: string;
  algorithmVersion: string;
}

function getStats(engineArg?: string): SystemStats {
  let name = "PAI";
  let algorithmVersion = "3.7.0";
  let catchphrase = "{name} here, ready to go";
  let repoUrl = `github.com/${AUTHOR}/dual-pai`;
  try {
    const settings = JSON.parse(readFileSync(join(CLAUDE_DIR, "settings.json"), "utf-8"));
    name = settings.daidentity?.displayName || settings.daidentity?.name || "PAI";
    algorithmVersion = (settings.pai?.algorithmVersion || algorithmVersion).replace(/^v/i, '');
    catchphrase = settings.daidentity?.startupCatchphrase || catchphrase;
    repoUrl = settings.pai?.repoUrl || repoUrl;
  } catch {}

  // Replace {name} placeholder in catchphrase
  catchphrase = catchphrase.replace(/\{name\}/gi, name);

  // Read counts from settings.json (updated by StopOrchestrator at end of each session)
  // This is instant - no spawning, no file scanning
  let skills = 0, workflows = 0, learnings = 0, userFiles = 0;

  try {
    const settings = JSON.parse(readFileSync(join(CLAUDE_DIR, "settings.json"), "utf-8"));
    if (settings.counts) {
      skills = settings.counts.skills || 0;
      workflows = settings.counts.workflows || 0;
      learnings = settings.counts.signals || 0;
      userFiles = settings.counts.files || 0;
    }
  } catch {
    // Fallback to reasonable defaults if settings.json is missing or malformed
    skills = 65;
    workflows = 339;
    learnings = 3000;
    userFiles = 172;
  }

  // Versjonene fra pakkene, ikke fra binærene: v2-binæren kan henge på en
  // stdin som ikke er en TTY, og begge er gratis å lese. Launcheren har
  // allerede sjekket at installert Claude Code er den pinnede.
  const pkgDir = join(import.meta.dir, "..", "..");
  const readJson = (f: string) => {
    try {
      return JSON.parse(readFileSync(f, "utf-8"));
    } catch {
      return {};
    }
  };
  const engine =
    engineArg === "claude"
      ? `Claude Code ${readJson(join(pkgDir, "package.json")).pai?.claudeCode ?? ""}`.trim()
      : `OpenCode ${readJson(join(pkgDir, "node_modules", "@opencode", "cli", "package.json")).version ?? ""}`.trim();

  return {
    name,
    catchphrase,
    repoUrl,
    skills,
    workflows,
    learnings,
    userFiles,
    engine,
    host: hostname().split(".")[0],
    algorithmVersion,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

function visibleLength(str: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: \x1b er ESC, starten på hver ANSI-fargekode — det er nettopp den som skal fjernes
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padEnd(str: string, width: number): string {
  return str + " ".repeat(Math.max(0, width - visibleLength(str)));
}


function center(str: string, width: number): string {
  const visible = visibleLength(str);
  const left = Math.floor((width - visible) / 2);
  return " ".repeat(Math.max(0, left)) + str + " ".repeat(Math.max(0, width - visible - left));
}

// ═══════════════════════════════════════════════════════════════════════════
// LARGE TERMINAL DESIGNS (85+ cols)
// ═══════════════════════════════════════════════════════════════════════════

// Navy/Steel Blue Theme - Neofetch style
function createNavyBanner(stats: SystemStats, width: number): string {
  const C = {
    // Logo colors matching reference image
    navy: rgb(30, 58, 138),       // Dark navy (P column, horizontal bars)
    medBlue: rgb(59, 130, 246),   // Medium blue (A column, bottom right blocks)
    lightBlue: rgb(147, 197, 253), // Light blue (I column accent)
    // Info section colors - blue palette gradient
    steel: rgb(51, 65, 85),
    slate: rgb(100, 116, 139),
    silver: rgb(203, 213, 225),
    white: rgb(240, 240, 255),
    muted: rgb(71, 85, 105),
    // Blue palette for data lines
    deepNavy: rgb(30, 41, 82),
    royalBlue: rgb(65, 105, 225),
    skyBlue: rgb(135, 206, 235),
    iceBlue: rgb(176, 196, 222),
    periwinkle: rgb(140, 160, 220),
    // URL - subtle dark teal (visible but muted)
    darkTeal: rgb(55, 100, 105),
  };

  // PAI logo - 2x scale (20 wide × 10 tall), same proportions
  // Each unit is 4 chars wide, 2 rows tall
  const B = "\u2588"; // Full block
  const logo = [
    // Row 1 (top bar) - 2 rows
    `${C.navy}${B.repeat(16)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(16)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    // Row 2 (P stem + gap + A upper) - 2 rows
    `${C.navy}${B.repeat(4)}${RESET}        ${C.navy}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(4)}${RESET}        ${C.navy}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    // Row 3 (middle bar) - 2 rows
    `${C.navy}${B.repeat(16)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(16)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    // Row 4 (P stem + gap + A leg) - 2 rows
    `${C.navy}${B.repeat(4)}${RESET}        ${C.medBlue}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(4)}${RESET}        ${C.medBlue}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    // Row 5 (P stem + gap + A leg) - 2 rows
    `${C.navy}${B.repeat(4)}${RESET}        ${C.medBlue}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(4)}${RESET}        ${C.medBlue}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
  ];
  const LOGO_WIDTH = 20;
  const SEPARATOR = `${C.steel}${BOX.v}${RESET}`;

  // Info section with Unicode icons - meaningful symbols (10 lines for perfect centering with 10-row logo)
  const infoLines = [
    `${C.slate}"${RESET}${C.lightBlue}${stats.catchphrase}${RESET}${C.slate}..."${RESET}`,
    `${C.steel}${BOX.h.repeat(24)}${RESET}`,
    `${C.navy}\u2B22${RESET}  ${C.slate}Engine${RESET}    ${C.silver}${stats.engine}${RESET}`,                               // ⬢ hexagon (the engine)
    `${C.royalBlue}\u2302${RESET}  ${C.slate}Host${RESET}      ${C.periwinkle}${stats.host}${RESET}`,                           // ⌂ house (this machine)
    `${C.navy}\u2699${RESET}  ${C.slate}Algo${RESET}      ${C.silver}${stats.algorithmVersion}${RESET}`,                      // ⚙ gear (algorithm)
    `${C.lightBlue}\u2726${RESET}  ${C.slate}Skills${RESET}    ${C.silver}${stats.skills}${RESET}`,             // ✦ four-pointed star (skills)
    `${C.skyBlue}\u21BB${RESET}  ${C.slate}WF${RESET}        ${C.iceBlue}${stats.workflows}${RESET}`,           // ↻ cycle (workflows)
    `${C.medBlue}\u2726${RESET}  ${C.slate}Signals${RESET}   ${C.skyBlue}${stats.learnings}${RESET}`,          // ✦ star (user sentiment signals)
    `${C.navy}\u2261${RESET}  ${C.slate}Files${RESET}     ${C.lightBlue}${stats.userFiles}${RESET}`,           // ≡ identical to (files/menu)
    `${C.steel}${BOX.h.repeat(24)}${RESET}`,
  ];

  // Layout with separator: logo | separator | info
  const gap = "   "; // Gap before separator
  const gapAfter = "  "; // Gap after separator
  const totalContentWidth = LOGO_WIDTH + gap.length + 1 + gapAfter.length + 28;
  const leftPad = Math.floor((width - totalContentWidth) / 2);
  const pad = " ".repeat(Math.max(2, leftPad));
  const emptyLogoSpace = " ".repeat(LOGO_WIDTH);

  // Vertically center logo relative to the full separator height
  const logoTopPad = Math.ceil((infoLines.length - logo.length) / 2);

  // Reticle corner characters (heavy/thick)
  const RETICLE = {
    tl: "\u250F", // ┏
    tr: "\u2513", // ┓
    bl: "\u2517", // ┗
    br: "\u251B", // ┛
    h: "\u2501",  // ━
  };

  // Frame dimensions
  const frameWidth = 70;
  const framePad = " ".repeat(Math.floor((width - frameWidth) / 2));

  const lines: string[] = [""];

  // Top border with full horizontal line and reticle corners
  const topBorder = `${C.steel}${RETICLE.tl}${RETICLE.h.repeat(frameWidth - 2)}${RETICLE.tr}${RESET}`;
  lines.push(`${framePad}${topBorder}`);
  lines.push("");

  // Header: Dual PAI · <DA-navnet>
  const headerText = projectHeader(C, stats.name);
  const headerPad = " ".repeat(Math.floor((width - visibleLength(headerText)) / 2));
  lines.push(`${headerPad}${headerText}`);
  lines.push(""); // Blank line between header and tagline

  // Tagline in light blue with ellipsis
  const quote = `${ITALIC}${C.lightBlue}${TAGLINE}${RESET}`;
  const quotePad = " ".repeat(Math.floor((width - visibleLength(quote)) / 2));
  lines.push(`${quotePad}${quote}`);

  // Extra space between top text area and main content
  lines.push("");
  lines.push("");

  // Main content: logo | separator | info
  for (let i = 0; i < infoLines.length; i++) {
    const logoIndex = i - logoTopPad;
    const logoRow = (logoIndex >= 0 && logoIndex < logo.length) ? logo[logoIndex] : emptyLogoSpace;
    const infoRow = infoLines[i];
    lines.push(`${pad}${padEnd(logoRow, LOGO_WIDTH)}${gap}${SEPARATOR}${gapAfter}${infoRow}`);
  }

  // Extra space between main content and footer
  lines.push("");
  lines.push("");

  // Footer: author + repo, then the credit line
  for (const line of footerLines(C, stats.repoUrl, C.muted)) lines.push(center(line, width));
  lines.push("");

  // Bottom border with full horizontal line and reticle corners
  const bottomBorder = `${C.steel}${RETICLE.bl}${RETICLE.h.repeat(frameWidth - 2)}${RETICLE.br}${RESET}`;
  lines.push(`${framePad}${bottomBorder}`);
  lines.push("");

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSIVE NAVY BANNER VARIANTS (progressive compaction)
// ═══════════════════════════════════════════════════════════════════════════

// Shared Navy color palette for all compact variants
function getNavyColors() {
  return {
    navy: rgb(30, 58, 138),
    medBlue: rgb(59, 130, 246),
    lightBlue: rgb(147, 197, 253),
    steel: rgb(51, 65, 85),
    slate: rgb(100, 116, 139),
    silver: rgb(203, 213, 225),
    iceBlue: rgb(176, 196, 222),
    periwinkle: rgb(140, 160, 220),
    skyBlue: rgb(135, 206, 235),
    royalBlue: rgb(65, 105, 225),
  };
}

// Small logo (10x5) for compact layouts
function getSmallLogo(C: ReturnType<typeof getNavyColors>) {
  const B = "\u2588";
  return [
    `${C.navy}${B.repeat(8)}${RESET}${C.lightBlue}${B.repeat(2)}${RESET}`,
    `${C.navy}${B.repeat(2)}${RESET}    ${C.navy}${B.repeat(2)}${RESET}${C.lightBlue}${B.repeat(2)}${RESET}`,
    `${C.navy}${B.repeat(8)}${RESET}${C.lightBlue}${B.repeat(2)}${RESET}`,
    `${C.navy}${B.repeat(2)}${RESET}    ${C.medBlue}${B.repeat(2)}${RESET}${C.lightBlue}${B.repeat(2)}${RESET}`,
    `${C.navy}${B.repeat(2)}${RESET}    ${C.medBlue}${B.repeat(2)}${RESET}${C.lightBlue}${B.repeat(2)}${RESET}`,
  ];
}

// «Dual PAI», with PAI in the logo's three blues
function projectName(C: ReturnType<typeof getNavyColors>): string {
  return `${C.slate}Dual ${RESET}${C.navy}P${RESET}${C.medBlue}A${RESET}${C.lightBlue}I${RESET}`;
}

function projectHeader(C: ReturnType<typeof getNavyColors>, name: string): string {
  return `${projectName(C)} ${C.steel}\u00b7${RESET} ${C.silver}${name}${RESET}`;
}

function footerLines(C: ReturnType<typeof getNavyColors>, repoUrl: string, creditColor: string): string[] {
  return [
    `${C.slate}by ${RESET}${C.medBlue}${AUTHOR}${RESET} ${C.steel}\u00b7${RESET} ${C.medBlue}${repoUrl}${RESET}`,
    `${creditColor}${CREDIT}${RESET}`,
  ];
}

// Medium Banner (70-84 cols) - No border, full content
function createNavyMediumBanner(stats: SystemStats, width: number): string {
  const C = getNavyColors();
  const B = "\u2588";

  // Full logo (20x10)
  const logo = [
    `${C.navy}${B.repeat(16)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(16)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(4)}${RESET}        ${C.navy}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(4)}${RESET}        ${C.navy}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(16)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(16)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(4)}${RESET}        ${C.medBlue}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(4)}${RESET}        ${C.medBlue}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(4)}${RESET}        ${C.medBlue}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
    `${C.navy}${B.repeat(4)}${RESET}        ${C.medBlue}${B.repeat(4)}${RESET}${C.lightBlue}${B.repeat(4)}${RESET}`,
  ];
  const LOGO_WIDTH = 20;
  const SEPARATOR = `${C.steel}${BOX.v}${RESET}`;

  const infoLines = [
    `${C.slate}"${RESET}${C.lightBlue}${stats.catchphrase}${RESET}${C.slate}..."${RESET}`,
    `${C.steel}${BOX.h.repeat(24)}${RESET}`,
    `${C.navy}\u2B22${RESET}  ${C.slate}Engine${RESET}    ${C.silver}${stats.engine}${RESET}`,                               // ⬢ hexagon (the engine)
    `${C.royalBlue}\u2302${RESET}  ${C.slate}Host${RESET}      ${C.periwinkle}${stats.host}${RESET}`,                           // ⌂ house (this machine)
    `${C.navy}\u2699${RESET}  ${C.slate}Algo${RESET}      ${C.silver}${stats.algorithmVersion}${RESET}`,                      // ⚙ gear (algorithm)
    `${C.lightBlue}\u2726${RESET}  ${C.slate}Skills${RESET}    ${C.silver}${stats.skills}${RESET}`,             // ✦ four-pointed star (skills)
    `${C.skyBlue}\u21BB${RESET}  ${C.slate}WF${RESET}        ${C.iceBlue}${stats.workflows}${RESET}`,           // ↻ cycle (workflows)
    `${C.medBlue}\u2726${RESET}  ${C.slate}Signals${RESET}   ${C.skyBlue}${stats.learnings}${RESET}`,
    `${C.navy}\u2261${RESET}  ${C.slate}Files${RESET}     ${C.lightBlue}${stats.userFiles}${RESET}`,
    `${C.steel}${BOX.h.repeat(24)}${RESET}`,
  ];

  const gap = "   ";
  const gapAfter = "  ";
  const totalContentWidth = LOGO_WIDTH + gap.length + 1 + gapAfter.length + 28;
  const leftPad = Math.floor((width - totalContentWidth) / 2);
  const pad = " ".repeat(Math.max(1, leftPad));
  const emptyLogoSpace = " ".repeat(LOGO_WIDTH);
  const logoTopPad = Math.ceil((infoLines.length - logo.length) / 2);

  const lines: string[] = [""];

  // Header (no border)
  const headerText = projectHeader(C, stats.name);
  const headerPad = " ".repeat(Math.max(0, Math.floor((width - visibleLength(headerText)) / 2)));
  lines.push(`${headerPad}${headerText}`);
  lines.push("");

  // Tagline
  const quote = `${ITALIC}${C.lightBlue}${TAGLINE}${RESET}`;
  const quotePad = " ".repeat(Math.max(0, Math.floor((width - visibleLength(quote)) / 2)));
  lines.push(`${quotePad}${quote}`);
  lines.push("");

  // Main content
  for (let i = 0; i < infoLines.length; i++) {
    const logoIndex = i - logoTopPad;
    const logoRow = (logoIndex >= 0 && logoIndex < logo.length) ? logo[logoIndex] : emptyLogoSpace;
    lines.push(`${pad}${padEnd(logoRow, LOGO_WIDTH)}${gap}${SEPARATOR}${gapAfter}${infoLines[i]}`);
  }

  lines.push("");
  for (const line of footerLines(C, stats.repoUrl, C.steel)) lines.push(center(line, width));
  lines.push("");

  return lines.join("\n");
}

// Compact Banner (55-69 cols) - Small logo, reduced info
function createNavyCompactBanner(stats: SystemStats, width: number): string {
  const C = getNavyColors();
  const logo = getSmallLogo(C);
  const LOGO_WIDTH = 10;
  const SEPARATOR = `${C.steel}${BOX.v}${RESET}`;

  // Condensed info (6 lines to match logo height better)
  // Truncate catchphrase for compact display
  const shortCatchphrase = stats.catchphrase.length > 20 ? `${stats.catchphrase.slice(0, 17)}...` : stats.catchphrase;
  const infoLines = [
    `${C.slate}"${RESET}${C.lightBlue}${shortCatchphrase}${RESET}${C.slate}"${RESET}`,
    `${C.steel}${BOX.h.repeat(18)}${RESET}`,
    `${C.navy}\u2B22${RESET} ${C.silver}${stats.engine}${RESET}`,
    `${C.royalBlue}\u2302${RESET} ${C.periwinkle}${stats.host}${RESET}`,
    `${C.lightBlue}\u2726${RESET} ${C.slate}Skills${RESET} ${C.silver}${stats.skills}${RESET}  ${C.skyBlue}\u21BB${RESET} ${C.iceBlue}${stats.workflows}${RESET}`,
    `${C.steel}${BOX.h.repeat(18)}${RESET}`,
  ];

  const gap = "  ";
  const gapAfter = " ";
  const totalContentWidth = LOGO_WIDTH + gap.length + 1 + gapAfter.length + 20;
  const leftPad = Math.floor((width - totalContentWidth) / 2);
  const pad = " ".repeat(Math.max(1, leftPad));
  const emptyLogoSpace = " ".repeat(LOGO_WIDTH);
  const logoTopPad = Math.floor((infoLines.length - logo.length) / 2);

  const lines: string[] = [""];

  // Condensed header
  lines.push(center(projectName(C), width));
  lines.push("");

  // Main content
  for (let i = 0; i < infoLines.length; i++) {
    const logoIndex = i - logoTopPad;
    const logoRow = (logoIndex >= 0 && logoIndex < logo.length) ? logo[logoIndex] : emptyLogoSpace;
    lines.push(`${pad}${padEnd(logoRow, LOGO_WIDTH)}${gap}${SEPARATOR}${gapAfter}${infoLines[i]}`);
  }
  lines.push("");

  return lines.join("\n");
}

// Minimal Banner (45-54 cols) - Very condensed
function createNavyMinimalBanner(stats: SystemStats, width: number): string {
  const C = getNavyColors();
  const logo = getSmallLogo(C);
  const LOGO_WIDTH = 10;

  // Minimal info beside logo
  const infoLines = [
    `${C.lightBlue}${stats.name}${RESET}${C.slate}@${stats.host}${RESET}`,
    `${C.silver}${stats.engine}${RESET}`,
    `${C.steel}${BOX.h.repeat(14)}${RESET}`,
    `${C.lightBlue}\u2726${RESET}${C.silver}${stats.skills}${RESET} ${C.skyBlue}\u21BB${RESET}${C.iceBlue}${stats.workflows}${RESET} ${C.navy}\u2699${RESET}${C.silver}${stats.algorithmVersion}${RESET}`,
    `${C.slate}${PROJECT}${RESET}`,
  ];

  const gap = " ";
  const totalContentWidth = LOGO_WIDTH + gap.length + 16;
  const leftPad = Math.floor((width - totalContentWidth) / 2);
  const pad = " ".repeat(Math.max(1, leftPad));

  const lines: string[] = [""];

  for (let i = 0; i < logo.length; i++) {
    lines.push(`${pad}${padEnd(logo[i], LOGO_WIDTH)}${gap}${infoLines[i] || ""}`);
  }
  lines.push("");

  return lines.join("\n");
}

// Ultra-compact Banner (<45 cols) - Text only, vertical
function createNavyUltraCompactBanner(stats: SystemStats, width: number): string {
  const C = getNavyColors();

  const lines: string[] = [""];
  lines.push(center(projectName(C), width));
  lines.push(center(`${C.lightBlue}${stats.name}${RESET}${C.slate}@${stats.host}${RESET}`, width));
  lines.push(center(`${C.silver}${stats.engine}${RESET}`, width));
  lines.push(center(`${C.steel}${BOX.h.repeat(Math.min(20, width - 4))}${RESET}`, width));
  lines.push(center(`${C.lightBlue}\u2726${RESET}${C.silver}${stats.skills}${RESET} ${C.skyBlue}\u21BB${RESET}${C.iceBlue}${stats.workflows}${RESET} ${C.navy}\u2699${RESET}${C.silver}${stats.algorithmVersion}${RESET}`, width));
  lines.push("");

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Banner Selection - Width-based routing
// ═══════════════════════════════════════════════════════════════════════════

// Breakpoints for responsive Navy banner
const BREAKPOINTS = {
  FULL: 85,      // Full Navy with border
  MEDIUM: 70,    // No border, full content
  COMPACT: 55,   // Small logo, reduced info
  MINIMAL: 45,   // Very condensed
  // Below 45: Ultra-compact text only
};

type DesignName = "navy" | "navy-medium" | "navy-compact" | "navy-minimal" | "navy-ultra";
const ALL_DESIGNS: DesignName[] = ["navy", "navy-medium", "navy-compact", "navy-minimal", "navy-ultra"];

function createBanner(forceDesign?: string, engine?: string): string {
  const width = getTerminalWidth();
  const stats = getStats(engine);

  // If a specific design is requested (for --design= flag or --test mode)
  if (forceDesign) {
    switch (forceDesign) {
      case "navy": return createNavyBanner(stats, width);
      case "navy-medium": return createNavyMediumBanner(stats, width);
      case "navy-compact": return createNavyCompactBanner(stats, width);
      case "navy-minimal": return createNavyMinimalBanner(stats, width);
      case "navy-ultra": return createNavyUltraCompactBanner(stats, width);
    }
  }

  // Width-based responsive routing (Navy theme only)
  if (width >= BREAKPOINTS.FULL) {
    return createNavyBanner(stats, width);
  } else if (width >= BREAKPOINTS.MEDIUM) {
    return createNavyMediumBanner(stats, width);
  } else if (width >= BREAKPOINTS.COMPACT) {
    return createNavyCompactBanner(stats, width);
  } else if (width >= BREAKPOINTS.MINIMAL) {
    return createNavyMinimalBanner(stats, width);
  } else {
    return createNavyUltraCompactBanner(stats, width);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const testMode = args.includes("--test");
const designArg = args.find(a => a.startsWith("--design="))?.split("=")[1];
const engineArg = args.find(a => a.startsWith("--engine="))?.split("=")[1];

try {
  if (testMode) {
    for (const design of ALL_DESIGNS) {
      console.log(`\n${"═".repeat(60)}`);
      console.log(`  DESIGN: ${design.toUpperCase()}`);
      console.log(`${"═".repeat(60)}`);
      console.log(createBanner(design, engineArg));
    }
  } else {
    console.log(createBanner(designArg, engineArg));
  }
} catch (e) {
  console.error("Banner error:", e);
}
