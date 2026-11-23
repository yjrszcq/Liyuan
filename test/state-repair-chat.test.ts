import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SessionManager } from "@liyuan/agent-runtime";
import { defaultState } from "../src/state.ts";
import { createRepairChat, deleteRepairChat, deleteRepairChatsForSessionPath, listRepairChats, saveRepairChats } from "../src/state-repair-chats.ts";
import { buildStateRepairPrompt, parseStateRepairResult } from "../src/state-repair.ts";

test("repair chats persist per parent session, delete independently, and cascade using generated session files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "liyuan-repair-chats-"));
  try {
    const sessionsDir = join(cwd, "sessions");
    const parentA = SessionManager.create(cwd, sessionsDir);
    const parentB = SessionManager.create(cwd, sessionsDir);
    parentA.appendCustomEntry("test", {});
    parentB.appendCustomEntry("test", {});
    parentA.flush();
    parentB.flush();
    const parentAId = parentA.getSessionId();
    const parentBId = parentB.getSessionId();
    const parentAPath = parentA.getSessionFile()!;
    const parentBPath = parentB.getSessionFile()!;
    const chatA = createRepairChat(cwd, parentAId, "Repair A");
    const chatB = createRepairChat(cwd, parentBId, "Repair B");
    chatA.messages.push({ role: "user", text: "第一轮纠错" });
    saveRepairChats(cwd, parentAId, [chatA]);
    assert.equal(listRepairChats(cwd, parentAId, "New chat")[0]?.messages[0]?.text, "第一轮纠错");
    assert.deepEqual(listRepairChats(cwd, parentBId, "New chat").map((chat) => chat.id), [chatB.id]);

    assert.equal(deleteRepairChat(cwd, parentAId, chatA.id, "New chat"), true);
    assert.deepEqual(listRepairChats(cwd, parentAId, "New chat"), []);
    assert.deepEqual(listRepairChats(cwd, parentBId, "New chat").map((chat) => chat.id), [chatB.id]);

    createRepairChat(cwd, parentAId, "Repair A");
    deleteRepairChatsForSessionPath(cwd, parentAPath);
    assert.deepEqual(listRepairChats(cwd, parentAId, "New chat"), []);
    assert.deepEqual(listRepairChats(cwd, parentBId, "New chat").map((chat) => chat.id), [chatB.id]);
    assert.equal(deleteRepairChat(cwd, parentAId, chatA.id, "New chat"), false);
    assert.equal(SessionManager.open(parentBPath, sessionsDir, cwd).getSessionId(), parentBId);
    const missingSessionPath = join(sessionsDir, "missing.jsonl");
    deleteRepairChatsForSessionPath(cwd, missingSessionPath);
    assert.equal(existsSync(missingSessionPath), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("multi-turn repair prompt retains conversation context and accepts evidence from an earlier user turn", () => {
	const history = [
		{ role: "user" as const, text: "账本地点错了。剧情写着：她已经走到新桥。" },
		{ role: "assistant" as const, text: "你希望将地点改成新桥吗？" },
		{ role: "user" as const, text: "对，请按上面的剧情修正。" },
	];
	const state = defaultState();
	const prompt = buildStateRepairPrompt({
		state,
		instruction: history.filter((message) => message.role === "user").map((message) => message.text).join("\n"),
		history,
		story: "她已经走到新桥。",
		charName: "云澜",
		userName: "沈舟",
		additionalPrompt: "简洁回答",
	});
	assert.ok(prompt.userText.includes(JSON.stringify(history[0]!.text)));
	assert.ok(prompt.userText.includes(JSON.stringify(history[2]!.text)));
  assert.match(prompt.systemPrompt, /只能添加与上述权限、安全、证据及确认规则相容/);

	const parsed = parseStateRepairResult(JSON.stringify({
		patch: { location: "新桥" },
		evidence: [{ source: "instruction", quote: "她已经走到新桥" }],
	}), { state, instruction: history.filter((message) => message.role === "user").map((message) => message.text), story: "她已经走到新桥。" });
	assert.equal(parsed.kind, "proposal");
	if (parsed.kind === "proposal") assert.equal(parsed.state.location, "新桥");
});
