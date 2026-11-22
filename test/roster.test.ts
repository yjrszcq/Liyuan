import assert from "node:assert/strict";
import { test } from "node:test";

import { applyPatch, defaultState, formatRosterIndex, formatState, samePlace } from "../src/state.ts";

test("名录不删：活跃状态里移除后名录仍在案", () => {
	const r1 = applyPatch(defaultState(), {
		characters: { 苏茜: { status: "在场" } },
		inventory: ["铁剑"],
		plot_threads: ["旧约"],
	});
	const r2 = applyPatch(r1.state, { characters: { 苏茜: null }, inventory: [], plot_threads: [] });
	assert.equal(Object.keys(r2.state.characters).length, 0);
	assert.ok("苏茜" in (r2.state.roster?.characters ?? {}));
	assert.ok("铁剑" in (r2.state.roster?.items ?? {}));
	assert.ok("旧约" in (r2.state.roster?.events ?? {}));
});


test("同地点大小写、Unicode 和空白变体保持在场", () => {
	assert.equal(samePlace("  GREAT　Hall  ", "great hall"), true);
	assert.equal(samePlace("Old Hall", "New Hall"), false);
	const s = applyPatch(defaultState(), {
		location: "Great Hall",
		characters: { Daenerys: { at: " great　hall " } },
	}).state;
	assert.match(formatState(s), /Daenerys：好感 0；在场/);
});

test("名录送模索引限定长度并标记省略历史条目", () => {
	const events = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`Event ${i} ${"x".repeat(90)}`, "day one"]));
	const index = formatRosterIndex({ ...defaultState(), roster: { characters: {}, items: {}, places: {}, events } });
	assert.ok(index.length <= 3003, `index length=${index.length}`);
	assert.ok(index.includes("未列"));
	assert.ok(index.includes("Event 59"));
	assert.ok(!index.includes("Event 0"));
});
test("名录容量：剧情线超上限丢最旧", () => {
	let s = defaultState();
	for (let i = 0; i < 70; i++) {
		s = applyPatch(s, { plot_threads: [`线索${i}`] }).state;
	}
	const events = Object.keys(s.roster?.events ?? {});
	assert.equal(events.length, 60);
	assert.ok(!events.includes("线索0"));
	assert.ok(events.includes("线索69"));
});

test("名录一句话超长截断", () => {
	const r = applyPatch(defaultState(), { characters: { 龙王: { status: "一".repeat(80) } } });
	assert.ok((r.state.roster?.characters["龙王"] ?? "").length <= 30);
});

test("名录编辑：离场条目可删；人物、地点、物品和事件活跃时受保护", () => {
	const r1 = applyPatch(defaultState(), {
		location: "山门",
		characters: { 苏茜: { status: "在场", at: "山门" }, 老周: { status: "在场", at: "山门" } },
		inventory: ["铁剑"],
		plot_threads: ["旧约"],
	});
	const r2 = applyPatch(r1.state, { characters: { 苏茜: null } });
	// 离场的苏茜：删除生效
	const r3 = applyPatch(r2.state, { roster: { characters: { 苏茜: null } } });
	assert.ok(!("苏茜" in (r3.state.roster?.characters ?? {})));
	assert.ok(r3.applied.some((a) => a.includes("roster.characters.苏茜 已移除")));
	// 当前角色、地点、物品与剧情线：显式删除均由活动状态保护
	const r4 = applyPatch(r3.state, {
		roster: {
			characters: { 老周: null },
			places: { 山门: null },
			items: { 铁剑: null },
			events: { 旧约: null },
		},
	});
	assert.ok("老周" in (r4.state.roster?.characters ?? {}));
	assert.ok("山门" in (r4.state.roster?.places ?? {}));
	assert.ok("铁剑" in (r4.state.roster?.items ?? {}));
	assert.ok("旧约" in (r4.state.roster?.events ?? {}));
});

test("名录编辑：删除的离场条目不因无关补丁复活，明确重新出现时再登记", () => {
	const appeared = applyPatch(defaultState(), {
		location: "山门",
		characters: { 苏茜: { status: "在场", at: "山门" } },
		inventory: ["铁剑"],
		plot_threads: ["旧约"],
	}).state;
	const left = applyPatch(appeared, { location: "旧街", inventory: [], plot_threads: [] }).state;
	const deleted = applyPatch(left, {
		roster: {
			characters: { 苏茜: null },
			places: { 山门: null },
			items: { 铁剑: null },
			events: { 旧约: null },
		},
	}).state;
	assert.ok(!("苏茜" in (deleted.roster?.characters ?? {})));
	assert.ok(!("山门" in (deleted.roster?.places ?? {})));
	assert.ok(!("铁剑" in (deleted.roster?.items ?? {})));
	assert.ok(!("旧约" in (deleted.roster?.events ?? {})));
	assert.ok("苏茜" in deleted.characters, "删除名录不删除世界状态账本");

	const afterUnrelatedPatch = applyPatch(deleted, { time: "次日清晨" }).state;
	assert.ok(!("苏茜" in (afterUnrelatedPatch.roster?.characters ?? {})), "无关状态写入不得重建已删除人物");
	assert.ok(!("山门" in (afterUnrelatedPatch.roster?.places ?? {})));
	assert.ok(!("铁剑" in (afterUnrelatedPatch.roster?.items ?? {})));
	assert.ok(!("旧约" in (afterUnrelatedPatch.roster?.events ?? {})));
	assert.ok("苏茜" in afterUnrelatedPatch.characters);

	const returned = applyPatch(afterUnrelatedPatch, {
		location: "山门",
		characters: { 苏茜: { status: "再次登场" } },
		inventory: ["铁剑"],
		plot_threads: ["旧约"],
	}).state;
	assert.ok("苏茜" in (returned.roster?.characters ?? {}), "明确更新角色时重新登记");
	assert.ok("山门" in (returned.roster?.places ?? {}));
	assert.ok("铁剑" in (returned.roster?.items ?? {}));
	assert.ok("旧约" in (returned.roster?.events ?? {}));

	const deleteWins = applyPatch(returned, {
		location: "旧街",
		characters: { 苏茜: { status: "刚更新但仍离场" } },
		roster: { characters: { 苏茜: null } },
	}).state;
	assert.ok(!("苏茜" in (deleteWins.roster?.characters ?? {})), "同补丁的明确删除优先于离场角色自动登记");
});

test("名录迁移：旧 roster 缺地点表时只补迁地点，不恢复已删除的离场人物", () => {
	const legacy = {
		...defaultState(),
		time: "开局",
		location: "山门",
		characters: { 苏茜: { affinity: 1, status: "离场", notes: "旧识", at: "旧街" } },
		roster: { characters: {}, items: {}, events: {} },
	};
	const migrated = applyPatch(legacy, { time: "后来" }).state;
	assert.equal(migrated.roster?.places?.["山门"], "开局");
	assert.equal(migrated.roster?.places?.["旧街"], "开局");
	assert.ok(!("苏茜" in (migrated.roster?.characters ?? {})));
});

test("名录迁移：无 roster 的旧账本完整登记现存人物、地点、物品和剧情线", () => {
	const legacy = {
		...defaultState(),
		time: "开局",
		location: "山门",
		characters: { 苏茜: { affinity: 1, status: "离场", notes: "旧识", at: "旧街" } },
		inventory: ["铁剑"],
		plot_threads: ["旧约"],
	};
	const migrated = applyPatch(legacy, { time: "后来" }).state;
	assert.equal(migrated.roster?.characters["苏茜"], "开局");
	assert.equal(migrated.roster?.items["铁剑"], "开局");
	assert.equal(migrated.roster?.events["旧约"], "开局");
	assert.equal(migrated.roster?.places?.["山门"], "开局");
	assert.equal(migrated.roster?.places?.["旧街"], "开局");
});

test("名录编辑：改一句话（60 字截断）；非法值告警忽略", () => {
	const r1 = applyPatch(defaultState(), { characters: { 苏茜: { status: "初登场" } } });
	const r2 = applyPatch(r1.state, { roster: { characters: { 苏茜: "三年前的旧识" } } });
	assert.equal(r2.state.roster?.characters["苏茜"], "三年前的旧识");
	const r3 = applyPatch(r2.state, { roster: { characters: { 苏茜: "长".repeat(90) } } });
	assert.equal((r3.state.roster?.characters["苏茜"] ?? "").length, 60);
	const r4 = applyPatch(r3.state, { roster: { characters: { 苏茜: 42 } } });
	assert.ok(r4.warnings.some((w) => w.includes("需要字符串或 null")));
});

test("名录编辑：roster 非对象/子表非对象告警忽略", () => {
	const r1 = applyPatch(defaultState(), { roster: "bad" });
	assert.ok(r1.warnings.some((w) => w.includes("roster 需要对象")));
	const r2 = applyPatch(defaultState(), { roster: { items: ["x"] } });
	assert.ok(r2.warnings.some((w) => w.includes("roster.items 需要对象")));
});
