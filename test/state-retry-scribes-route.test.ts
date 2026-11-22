import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";

import { handleApiRequest, type RestHost } from "../server/rest.ts";

test("POST /api/state/retry-scribes invokes pending retry and refuses while streaming", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-state-retry-scribes-"));
	let streaming = false;
	let calls = 0;
	const host = {
		cwd,
		isStreaming: () => streaming,
		retryPendingScribes: async () => {
			calls++;
			return { kind: "applied", message: "待补记账已完成。", pendingCount: 0 };
		},
	} as unknown as RestHost;
	const server = createServer((req, res) => {
		void handleApiRequest(req, res, host);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/api/state/retry-scribes`;
	try {
		const response = await fetch(url, { method: "POST", body: "{}" });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { kind: "applied", message: "待补记账已完成。", pendingCount: 0 });
		assert.equal(calls, 1);

		streaming = true;
		const refused = await fetch(url, { method: "POST", body: "{}" });
		assert.equal(refused.status, 409);
		assert.equal(calls, 1, "busy retry must not reach the engine");
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close((error) => error ? closed.reject(error) : closed.resolve());
		await closed.promise;
		rmSync(cwd, { recursive: true, force: true });
	}
});
