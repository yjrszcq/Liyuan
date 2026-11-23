import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";

import { handleApiRequest, type RestHost } from "../server/rest.ts";

test("state repair routes expose proposal/apply/undo and block writes while streaming", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-state-repair-route-"));
	let streaming = false;
  const calls: string[] = [];
  const activeSessionId = "session-1";
  const assertSession = (sessionId: string) => {
    if (sessionId !== activeSessionId) throw new Error("session mismatch");
  };
  const host = {
    cwd,
    isStreaming: () => streaming,
    repairChats: () => ({ chats: [] }),
    createRepairChat: (sessionId: string) => { assertSession(sessionId); calls.push("create"); return { chat: { id: "chat-1", title: "新建状态修改", messages: [] } }; },
    deleteRepairChat: (id: string, sessionId: string) => { assertSession(sessionId); calls.push("delete"); return { ok: id === "chat-1" }; },
    renameRepairChat: (id: string, title: string, sessionId: string) => { assertSession(sessionId); calls.push(`rename:${title}`); return { chat: { id, title, messages: [] } }; },
    rewindRepairChat: (id: string, index: number, sessionId: string) => { assertSession(sessionId); calls.push(`rewind:${index}`); return { chat: { id, title: "title", messages: [] } }; },
    repairTurn: async (id: string, text: string, sessionId: string, _onDelta?: unknown, index?: number) => { assertSession(sessionId); calls.push(index === undefined ? "turn" : `turn:${index}`); return { chat: { id, title: text, messages: [{ role: "user", text }] } }; },
    applyRepairChat: (_id: string, _token: string, sessionId: string) => { assertSession(sessionId); calls.push("apply"); return { ok: true }; },
    stateRepairStatus: () => ({ undoable: true, undoToken: "active-repair" }),
    undoStateRepair: (token: string) => { calls.push(`undo:${token}`); return { ok: true }; },
  } as unknown as RestHost;
	const server = createServer((req, res) => { void handleApiRequest(req, res, host); });
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}/api/state/repair`;
  try {
    const chats = await fetch(`${base}/chats`);
    assert.deepEqual(await chats.json(), { chats: [] });
    const staleCreate = await fetch(`${base}/chats`, { method: "POST", body: JSON.stringify({ sessionId: "session-old" }) });
    assert.equal(staleCreate.ok, false);
    assert.deepEqual(calls, []);
    const created = await fetch(`${base}/chats`, { method: "POST", body: JSON.stringify({ sessionId: activeSessionId }) });
    assert.deepEqual(await created.json(), { chat: { id: "chat-1", title: "新建状态修改", messages: [] } });
    const staleRename = await fetch(`${base}/chats`, { method: "PUT", body: JSON.stringify({ id: "chat-1", title: "标题", sessionId: "session-old" }) });
    assert.equal(staleRename.ok, false);
    const emptyRename = await fetch(`${base}/chats`, { method: "PUT", body: JSON.stringify({ id: "chat-1", title: "  ", sessionId: activeSessionId }) });
    assert.equal(emptyRename.ok, false);
    const renamed = await fetch(`${base}/chats`, { method: "PUT", body: JSON.stringify({ id: "chat-1", title: " 新标题 ", sessionId: activeSessionId }) });
    assert.equal((await renamed.json() as { chat: { title: string } }).chat.title, "新标题");
    const staleRewind = await fetch(`${base}/rewind`, { method: "POST", body: JSON.stringify({ id: "chat-1", index: 0, sessionId: "session-old" }) });
    assert.equal(staleRewind.ok, false);
    const rewound = await fetch(`${base}/rewind`, { method: "POST", body: JSON.stringify({ id: "chat-1", index: 2, sessionId: activeSessionId }) });
    assert.equal((await rewound.json() as { chat: { id: string } }).chat.id, "chat-1");
    const invalidRewindIndex = await fetch(`${base}/rewind`, { method: "POST", body: JSON.stringify({ id: "chat-1", index: 0.5, sessionId: activeSessionId }) });
    assert.equal(invalidRewindIndex.ok, false);
    const staleTurn = await fetch(`${base}/turn`, { method: "POST", body: JSON.stringify({ id: "chat-1", text: "错误会话", sessionId: "session-old" }) });
    assert.equal(staleTurn.ok, false);
    const turn = await fetch(`${base}/turn`, { method: "POST", body: JSON.stringify({ id: "chat-1", text: "更新地点", sessionId: activeSessionId }) });
    assert.equal((await turn.json() as { chat: { id: string } }).chat.id, "chat-1");
    const editedTurn = await fetch(`${base}/turn`, { method: "POST", body: JSON.stringify({ id: "chat-1", text: "替换", sessionId: activeSessionId, index: 0 }) });
    assert.equal((await editedTurn.json() as { chat: { title: string } }).chat.title, "替换");
    const invalidTurnIndex = await fetch(`${base}/turn`, { method: "POST", body: JSON.stringify({ id: "chat-1", text: "bad index", sessionId: activeSessionId, index: -1 }) });
    assert.equal(invalidTurnIndex.ok, false);
    const staleApply = await fetch(`${base}/apply`, { method: "POST", body: JSON.stringify({ id: "chat-1", token: "proposal", sessionId: "session-old" }) });
    assert.equal(staleApply.ok, false);
    const chatApply = await fetch(`${base}/apply`, { method: "POST", body: JSON.stringify({ id: "chat-1", token: "proposal", sessionId: activeSessionId }) });
    assert.deepEqual(await chatApply.json(), { ok: true });
    const staleDelete = await fetch(`${base}/chats?id=chat-1&sessionId=session-old`, { method: "DELETE" });
    assert.equal(staleDelete.ok, false);
    const deleted = await fetch(`${base}/chats?id=chat-1&sessionId=${activeSessionId}`, { method: "DELETE" });
    assert.deepEqual(await deleted.json(), { ok: true });
		const status = await fetch(`${base}/status`);
		assert.deepEqual(await status.json(), { undoable: true, undoToken: "active-repair" });
		const missing = await fetch(`${base}/undo`, { method: "POST", body: "{}" });
		assert.equal(missing.ok, false);
    assert.deepEqual(calls, ["create", "rename:新标题", "rewind:2", "turn", "turn:0", "apply", "delete"], "omitting the undo token must not run undo");
		const undo = await fetch(`${base}/undo`, { method: "POST", body: JSON.stringify({ token: "active-repair" }) });
		assert.equal(undo.ok, true);
		streaming = true;
    const refused = await fetch(`${base}/turn`, { method: "POST", body: JSON.stringify({ id: "chat-1", text: "ignored", sessionId: activeSessionId }) });
		assert.equal(refused.status, 409);
    assert.deepEqual(calls, ["create", "rename:新标题", "rewind:2", "turn", "turn:0", "apply", "delete", "undo:active-repair"]);
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close((error) => error ? closed.reject(error) : closed.resolve());
		await closed.promise;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("repair stream delivers model deltas before the completed reply", async () => {
  const release = Promise.withResolvers<void>();
  let receivedIndex: number | undefined;
  const host = {
    isStreaming: () => false,
    repairTurn: async (_id: string, _text: string, _session: string, onDelta: (kind: "thinking" | "text", delta: string) => void, index?: number) => {
      receivedIndex = index;
      onDelta("thinking", "核对中");
      await release.promise;
      onDelta("text", "回复");
      return { chat: { id: "one", title: "title", messages: [] } };
    },
  } as unknown as RestHost;
  const server = createServer((req, res) => { void handleApiRequest(req, res, host); });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/state/repair/turn/stream`, { method: "POST", body: JSON.stringify({ id: "one", text: "fix", sessionId: "parent", index: 4 }) });
    assert.ok(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.deepEqual(JSON.parse(new TextDecoder().decode(first.value).trim()), { type: "delta", kind: "thinking", delta: "核对中" });
    release.resolve();
    let remaining = "";
    const decoder = new TextDecoder();
    while (true) { const { value, done } = await reader.read(); remaining += decoder.decode(value, { stream: !done }); if (done) break; }
    const events = remaining.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events[0], { type: "delta", kind: "text", delta: "回复" });
    assert.equal(events[1].result.chat.id, "one");
    assert.equal(receivedIndex, 4);
  } finally {
    release.resolve();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
