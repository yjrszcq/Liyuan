import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SessionManager } from "@liyuan/agent-runtime";
import { defaultState } from "../src/state.ts";
import { createRepairChatHistory, createRepairChat, deleteRepairChat, deleteRepairChatsForSessionPath, listRepairChats, markRepairProposalApplied, saveRepairChats } from "../src/state-repair-chats.ts";
import { buildStateRepairPrompt, parseStateRepairResult, type StateRepairParseResult } from "../src/state-repair.ts";

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

test("applied status is persisted only on the matching proposal and leaves older proposals pending", () => {
  const cwd = mkdtempSync(join(tmpdir(), "liyuan-repair-applied-"));
  try {
    const sessionId = "parent-session";
    const chats = [
      { id: "chat-a", title: "A", messages: [
        { role: "assistant" as const, text: "old proposal", proposal: { token: "old-token", changes: [], evidence: [] } },
        { role: "assistant" as const, text: "new proposal", thinking: "actual model reasoning", proposal: { token: "new-token", changes: [], evidence: [] } },
      ] },
      { id: "chat-b", title: "B", messages: [
        { role: "assistant" as const, text: "other proposal", proposal: { token: "other-token", changes: [], evidence: [] } },
      ] },
    ];
    saveRepairChats(cwd, sessionId, chats);

    assert.equal(markRepairProposalApplied(cwd, sessionId, "chat-a", "new-token", "New chat"), true);
    assert.equal(markRepairProposalApplied(cwd, sessionId, "chat-a", "missing-token", "New chat"), false);
    const saved = listRepairChats(cwd, sessionId, "New chat");
    assert.equal(saved[0]?.messages[0]?.proposal?.applied, undefined);
    assert.equal(saved[0]?.messages[1]?.proposal?.applied, true);
    assert.equal(saved[0]?.messages[1]?.thinking, "actual model reasoning");
    assert.equal(saved[1]?.messages[0]?.proposal?.applied, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("repair chat reads remove only legacy assistant boilerplate", () => {
  const cwd = mkdtempSync(join(tmpdir(), "liyuan-repair-boilerplate-"));
  const sessionId = "parent";
  const proposalText = "已生成状态修改提案，请核对差异与证据后确认应用。";
  const answerPrefix = "只读答复，未生成修改提案。";
  try {
    const chat = createRepairChat(cwd, sessionId, "Repair");
    chat.messages = [
      { role: "user", text: `${answerPrefix}\n\n请解释这句话` },
      { role: "assistant", text: `${answerPrefix}\n\n实际回答\n仍保留换行` },
      { role: "assistant", text: proposalText, proposal: { token: "legacy", changes: [], evidence: [] } },
      { role: "assistant", text: `模型引用：${proposalText}` },
      { role: "assistant", text: "Read-only answer; no modification proposal was generated.\n\nEnglish answer" },
      { role: "assistant", text: "A state-modification proposal is ready. Review the changes and evidence before applying." },
    ];
    saveRepairChats(cwd, sessionId, [chat]);
    const saved = listRepairChats(cwd, sessionId, "Repair")[0]!;
    assert.deepEqual(saved.messages.map(({ text }) => text), [
      `${answerPrefix}\n\n请解释这句话`, "实际回答\n仍保留换行", "", `模型引用：${proposalText}`, "English answer", "",
    ]);
    assert.equal(saved.messages[2]?.proposal?.token, "legacy");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("repair rewind truncates from a user message, expires proposals, and failed regeneration preserves history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "liyuan-repair-history-"));
  const sessionId = "parent-session";
  const chat = createRepairChat(cwd, sessionId, "Repair");
  chat.messages = [
    { role: "user", text: "old request" },
    { role: "assistant", text: "old proposal", proposal: { token: "old", changes: [], evidence: [] } },
    { role: "user", text: "later request" },
    { role: "assistant", text: "later answer" },
  ];
  saveRepairChats(cwd, sessionId, [chat]);
  let activeSession = sessionId;
  let invalidations = 0;
  let receivedHistory: Array<{ role: "user" | "assistant"; text: string }> = [];
  let answer: Promise<StateRepairParseResult & { token?: string }> = Promise.resolve({ kind: "invalid", reason: "model failed" });
  const history = createRepairChatHistory({
    cwd,
    getSessionId: () => activeSession,
    isStreaming: () => false,
    newChatTitle: () => "Repair",
    invalidateProposal: () => { invalidations++; },
    propose: async (_id, _text, messages) => { receivedHistory = messages; return await answer; },
  });
  try {
    assert.throws(() => history.rewindRepairChat(chat.id, 1, sessionId), /有效的用户消息/);
    const rewound = history.rewindRepairChat(chat.id, 2, sessionId).chat;
    assert.deepEqual(rewound.messages.map(({ text }) => text), ["old request", "old proposal"]);
    assert.equal(rewound.messages[1]?.proposal?.expired, true);
    assert.equal(history.canApplyProposal(chat.id, "old", sessionId), false);
    assert.equal(invalidations, 1);

    const beforeFailure = JSON.stringify(rewound.messages);
    const result = await history.repairTurn(chat.id, "replacement", sessionId, undefined, 0);
    assert.deepEqual(result, { kind: "invalid", reason: "model failed" });
    assert.deepEqual(receivedHistory, [{ role: "user", text: "replacement" }]);
    assert.equal(JSON.stringify(listRepairChats(cwd, sessionId, "Repair")[0]?.messages), beforeFailure);

    const pendingAnswer = Promise.withResolvers<{ kind: "invalid"; reason: string }>();
    answer = pendingAnswer.promise;
    const pending = history.repairTurn(chat.id, "retry", sessionId, undefined, 0);
    assert.throws(() => history.rewindRepairChat(chat.id, 0, sessionId), /当前有生成或记账任务/);
    pendingAnswer.resolve({ kind: "invalid", reason: "model failed" });
    await pending;
    activeSession = "switched-session";
    assert.throws(() => history.rewindRepairChat(chat.id, 0, sessionId), /会话已切换/);
    activeSession = sessionId;
    answer = Promise.resolve({ kind: "proposal", repair: { patch: {}, evidence: [] }, state: defaultState(), changes: [], token: "fresh" });
    const regenerated = await history.repairTurn(chat.id, "corrected first request", sessionId, undefined, 0);
    assert.ok("chat" in regenerated);
    assert.deepEqual(regenerated.chat.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "corrected first request" },
      { role: "assistant", text: "" },
    ]);
    assert.equal(regenerated.chat.messages[1]?.proposal?.token, "fresh");
    assert.equal(history.canApplyProposal(chat.id, "fresh", sessionId), true);
    assert.equal(history.reconcileProposalExpiry(sessionId, { kind: "busy" })[0]?.messages[1]?.proposal?.expired, undefined);
    assert.equal(history.reconcileProposalExpiry(sessionId, { kind: "current", sessionId, chatId: chat.id, token: "fresh" })[0]?.messages[1]?.proposal?.expired, undefined);
    assert.equal(history.reconcileProposalExpiry(sessionId, { kind: "none" })[0]?.messages[1]?.proposal?.expired, true);
    assert.equal(history.canApplyProposal(chat.id, "fresh", sessionId), false);
    answer = Promise.resolve({ kind: "answer", text: "仅保留模型实际回答" });
    const answered = await history.repairTurn(chat.id, "查看账本", sessionId, undefined, 0);
    assert.ok("chat" in answered);
    assert.equal(answered.chat.messages[1]?.text, "仅保留模型实际回答");
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
