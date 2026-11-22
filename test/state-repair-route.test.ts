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
	const host = {
		cwd,
		isStreaming: () => streaming,
		proposeStateRepair: async (instruction: string) => { calls.push(`propose:${instruction}`); return { kind: "clarification", question: "Which item?" }; },
		applyStateRepair: (token: string) => { calls.push(`apply:${token}`); return { ok: true }; },
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
		const proposal = await fetch(base, { method: "POST", body: JSON.stringify({ instruction: "账本物品记错" }) });
		assert.equal(proposal.status, 200);
		assert.deepEqual(await proposal.json(), { kind: "clarification", question: "Which item?" });
		const status = await fetch(`${base}/status`);
		assert.deepEqual(await status.json(), { undoable: true, undoToken: "active-repair" });
		const apply = await fetch(`${base}/apply`, { method: "POST", body: JSON.stringify({ token: "server-token" }) });
		assert.deepEqual(await apply.json(), { ok: true });
		const missing = await fetch(`${base}/undo`, { method: "POST", body: "{}" });
		assert.equal(missing.ok, false);
		assert.equal(calls.length, 2, "omitting the undo token must not run undo");
		const undo = await fetch(`${base}/undo`, { method: "POST", body: JSON.stringify({ token: "active-repair" }) });
		assert.equal(undo.ok, true);
		streaming = true;
		const refused = await fetch(base, { method: "POST", body: JSON.stringify({ instruction: "ignored" }) });
		assert.equal(refused.status, 409);
		assert.deepEqual(calls, ["propose:账本物品记错", "apply:server-token", "undo:active-repair"]);
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close((error) => error ? closed.reject(error) : closed.resolve());
		await closed.promise;
		rmSync(cwd, { recursive: true, force: true });
	}
});
