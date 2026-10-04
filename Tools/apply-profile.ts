#!/usr/bin/env bun
/**
 * apply-profile.ts - Apply a model profile to all agents
 * Usage: bun tools/apply-profile.ts <profile-name>
 * Example: bun tools/apply-profile.ts local
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { join } from "node:path";

const PROFILES_DIR = ".opencode/profiles";
const AGENTS_DIR = ".opencode/agents";

function main() {
  const profileName = process.argv[2];

  if (!profileName) {
    console.log("Usage: bun tools/apply-profile.ts <profile-name>");
    console.log("\nAvailable profiles:");
    const profiles = readdirSync(PROFILES_DIR).filter(f => f.endsWith(".yaml"));
    for (const p of profiles) console.log(`  - ${p.replace(".yaml", "")}`);
    process.exit(1);
  }

  const profilePath = join(PROFILES_DIR, `${profileName}.yaml`);
  const profileContent = readFileSync(profilePath, "utf-8");
  const profile = parseYaml(profileContent);

  console.log(`\n🔄 Applying profile: ${profile.name}`);
  console.log(`   ${profile.description}\n`);

  const agentFiles = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md"));

  for (const agentFile of agentFiles) {
    const agentName = agentFile.replace(".md", "");
    const newModel = profile.models[agentName] || profile.models.default;

    const agentPath = join(AGENTS_DIR, agentFile);
    let content = readFileSync(agentPath, "utf-8");

    // Replace model: line
    const modelRegex = /^model:\s*.+$/m;
    const oldModel = content.match(modelRegex)?.[0];
    content = content.replace(modelRegex, `model: ${newModel}`);

    writeFileSync(agentPath, content);
    console.log(`✅ ${agentName}: ${oldModel?.replace("model: ", "")} → ${newModel}`);
  }

  console.log(`\n✨ Profile '${profileName}' applied to ${agentFiles.length} agents`);
}

main();
