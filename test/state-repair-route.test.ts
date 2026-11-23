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
    repairTurn: async (id: string, text: string, sessionId: string) => { assertSession(sessionId); calls.push("turn"); return { chat: { id, title: text, messages: [{ role: "user", text }] } }; },
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
    const staleTurn = await fetch(`${base}/turn`, { method: "POST", body: JSON.stringify({ id: "chat-1", text: "错误会话", sessionId: "session-old" }) });
    assert.equal(staleTurn.ok, false);
    const turn = await fetch(`${base}/turn`, { method: "POST", body: JSON.stringify({ id: "chat-1", text: "更新地点", sessionId: activeSessionId }) });
    assert.equal((await turn.json() as { chat: { id: string } }).chat.id, "chat-1");
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
    assert.deepEqual(calls, ["create", "turn", "apply", "delete"], "omitting the undo token must not run undo");
		const undo = await fetch(`${base}/undo`, { method: "POST", body: JSON.stringify({ token: "active-repair" }) });
		assert.equal(undo.ok, true);
		streaming = true;
    const refused = await fetch(`${base}/turn`, { method: "POST", body: JSON.stringify({ id: "chat-1", text: "ignored", sessionId: activeSessionId }) });
		assert.equal(refused.status, 409);
    assert.deepEqual(calls, ["create", "turn", "apply", "delete", "undo:active-repair"]);
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close((error) => error ? closed.reject(error) : closed.resolve());
		await closed.promise;
		rmSync(cwd, { recursive: true, force: true });
	}
});
