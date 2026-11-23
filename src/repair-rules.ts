import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveConfigPath } from "./paths.ts";
import { rulesAgentDir } from "./user-rules.ts";
import { formatRepairPromptMigration } from "./prompt-entries.ts";

export const REPAIR_RULES_FILE = "REPAIR_APPEND_SYSTEM.md";
const shippedRepairRules = (): string => readFileSync(new URL("../assets/REPAIR_APPEND_SYSTEM.md", import.meta.url), "utf8");

export function repairRulesPath(agentDir = rulesAgentDir()): string {
	return join(agentDir, REPAIR_RULES_FILE);
}

/** Seed the shipped template once; an existing (including empty) user file always wins. */
export function seedRepairRules(agentDir = rulesAgentDir()): void {
	const target = repairRulesPath(agentDir);
	try {
		mkdirSync(agentDir, { recursive: true });
		const fd = openSync(target, "wx");
		try {
			writeFileSync(fd, shippedRepairRules(), "utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		// Concurrent startup or read-only home: no user data is overwritten.
	}
}

/**
 * Move the retired config.repairPrompt into the prompt-entry file. The hash marker makes
 * startup idempotent while leaving the legacy Markdown bytes intact and editable.
 */
export function migrateLegacyRepairPrompt(agentDir = rulesAgentDir(), configFile = resolveConfigPath(process.cwd())): void {
	// Remove only the empty leading heading shipped by older templates; preserve user content.
	try {
		const path = repairRulesPath(agentDir);
		const content = readFileSync(path, "utf8");
		const cleaned = content.replace(/^# 状态修改工作方式[ \t]*\r?\n(?:[ \t]*\r?\n)*(?=#{1,6}[ \t])/, "");
		if (cleaned !== content) writeFileSync(path, cleaned, "utf8");
	} catch {
		// A missing file is seeded below; unreadable files are left untouched.
	}
	if (!existsSync(configFile)) {
		seedRepairRules(agentDir);
		return;
	}
	let config: Record<string, unknown>;
	try {
		config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
	} catch {
		seedRepairRules(agentDir);
		return;
	}
	if (!Object.hasOwn(config, "repairPrompt")) {
		seedRepairRules(agentDir);
		return;
	}
	const legacy = typeof config.repairPrompt === "string" ? config.repairPrompt : "";
	const target = repairRulesPath(agentDir);
	let current: string;
	try {
		current = existsSync(target) ? readFileSync(target, "utf8") : shippedRepairRules();
	} catch {
		return;
	}
	if (legacy.trim()) {
		const digest = createHash("sha256").update(legacy).digest("hex");
		const marker = `<!-- legacy repairPrompt migration: ${digest} -->`;
		if (!current.includes(marker)) {
			const separator = current.endsWith("\n") ? "" : "\n";
			current = `${current}${separator}\n<!--\n${marker}\n-->\n\n${formatRepairPromptMigration(legacy, digest)}`;
		}
		try {
			if (!existsSync(target)) {
				const fd = openSync(target, "wx");
				try {
					writeFileSync(fd, current, "utf8");
				} finally {
					closeSync(fd);
				}
			} else {
				const latest = readFileSync(target, "utf8");
				if (!latest.includes(marker)) writeFileSync(target, `${latest}${latest.endsWith("\n") ? "" : "\n"}\n<!--\n${marker}\n-->\n\n${formatRepairPromptMigration(legacy, digest)}`, "utf8");
			}
		} catch {
			return;
		}
	}
	delete config.repairPrompt;
	try {
		const backup = `${configFile}.bak`;
		if (!existsSync(backup)) copyFileSync(configFile, backup);
		writeFileSync(configFile, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	} catch {
		// Keep the legacy value if config could not be updated; the file marker prevents duplication.
	}
	seedRepairRules(agentDir);
}

/** Existing empty files intentionally render empty instead of falling back to shipped text. */
export function repairRulesContent(agentDir = rulesAgentDir()): string {
	const path = repairRulesPath(agentDir);
	return existsSync(path) ? readFileSync(path, "utf8") : shippedRepairRules();
}
