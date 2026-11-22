/**
 * 戏境状态栏面板（右侧分栏）：
 * 与左侧扮演正文完全平级、浑然一体的剧情设定总览。
 * 杜绝细碎气泡与悬浮框，采用优雅的文人长卷章节排版。
 */

import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiPut, type StatePatchResult } from "../api.ts";
import type { WorldState } from "../wire.ts";
import { IconTrash } from "./icons.tsx";
import { ConfirmButton, useAction } from "./kit.tsx";
import { Editable, isEmptyState } from "./StatusStrip.tsx";
import { t } from "../i18n/index.ts";

export interface StatusPanelProps {
	state: WorldState | null;
	toast: (level: "info" | "warning" | "error", text: string) => void;
	pendingScribeCount: number;
	retryingScribes: boolean;
	onRetryPendingScribes: () => void;
}

type RepairEvidence = { source: "instruction" | "story"; quote: string };
type RepairChange = { path: string; before: unknown; after: unknown };
type RepairResponse =
	| { kind: "proposal"; token: string; changes: RepairChange[]; repair: { evidence: RepairEvidence[] } }
	| { kind: "clarification"; question: string; evidence: RepairEvidence[] }
	| { kind: "invalid"; reason: string };

export function StatusPanel({ state, toast, pendingScribeCount, retryingScribes, onRetryPendingScribes }: StatusPanelProps) {
	const [repairInstruction, setRepairInstruction] = useState("");
	const [repairResult, setRepairResult] = useState<RepairResponse | null>(null);
	const [repairBusy, setRepairBusy] = useState(false);
	const repairActionResolved = useRef(false);
	const instructionVersion = useRef(0);
	const [undoToken, setUndoToken] = useState<string | null>(null);
	const [undoReason, setUndoReason] = useState("");
	useEffect(() => {
		let mounted = true;
		void apiGet<{ undoable: boolean; undoToken?: string; reason?: string }>("/api/state/repair/status", { bypassCache: true })
			.then((status) => { if (mounted && !repairActionResolved.current) { setUndoToken(status.undoable ? status.undoToken ?? null : null); setUndoReason(status.reason ?? ""); } })
			.catch(() => undefined);
		return () => { mounted = false; };
	}, []);
	const requestRepair = async () => {
		if (!repairInstruction.trim() || repairBusy) return;
		const version = instructionVersion.current;
		setRepairBusy(true);
		setRepairResult(null);
		try {
			const result = await apiPost<RepairResponse>("/api/state/repair", { instruction: repairInstruction });
			if (version !== instructionVersion.current) return;
			setRepairResult(result);
			if (result.kind === "invalid") toast("warning", result.reason);
		} catch (error) { toast("error", error instanceof Error ? error.message : String(error)); }
		finally { setRepairBusy(false); }
	};
	const applyRepair = async () => {
		if (repairResult?.kind !== "proposal") return;
		setRepairBusy(true);
		try {
			const result = await apiPost<{ ok: boolean; reason?: string; warning?: boolean; undoToken?: string }>("/api/state/repair/apply", { token: repairResult.token });
			if (!result.ok) { setRepairResult(null); toast("warning", result.reason ?? t("修复提案已失效")); return; }
			repairActionResolved.current = true;
			setRepairResult(null);
			setRepairInstruction("");
			setUndoToken(result.undoToken ?? null);
			setUndoReason("");
			toast(result.warning ? "warning" : "info", result.warning ? t("修复已写入分支但缓存更新失败") : t("状态修复已写入当前分支"));
		} catch (error) { toast("error", error instanceof Error ? error.message : String(error)); }
		finally { setRepairBusy(false); }
	};
	const undoRepair = async () => {
		if (!undoToken) return;
		setRepairBusy(true);
		try {
			const result = await apiPost<{ ok: boolean; reason?: string; warning?: boolean }>("/api/state/repair/undo", { token: undoToken });
			if (!result.ok) { repairActionResolved.current = true; setUndoToken(null); setUndoReason(result.reason ?? ""); toast("warning", result.reason ?? t("没有可撤销的状态修复")); return; }
			repairActionResolved.current = true;
			setRepairResult(null);
			setRepairInstruction("");
			setUndoToken(null);
			setUndoReason("");
			toast(result.warning ? "warning" : "info", result.warning ? t("修复已写入分支但缓存更新失败") : t("状态修复已撤销"));
		} catch (error) { toast("error", error instanceof Error ? error.message : String(error)); }
		finally { setRepairBusy(false); }
	};
	const { run } = useAction(toast);

	const patch = (p: Record<string, unknown>) =>
		run(async () => {
			const r = await apiPut<StatePatchResult>("/api/state", { patch: p });
			for (const w of r.warnings) toast("warning", w);
		});

	const num = (v: string, fallback: number): number => {
		const n = Number(v);
		return Number.isFinite(n) ? n : fallback;
	};

	const empty = !state || isEmptyState(state);
	const characters = Object.entries(state?.characters ?? {});
	const flags = Object.entries(state?.flags ?? {});
	const inventory = state?.inventory ?? [];
	const plotThreads = state?.plot_threads ?? [];

	return (
		<div className="status-panel">
			{pendingScribeCount > 0 && (
				<div className="sp-pending-scribe" role="status" aria-live="polite">
					<span>{t("有 {n} 拍记账待补", { n: pendingScribeCount })}</span>
					<button type="button" className="drawer-btn primary" disabled={retryingScribes} aria-busy={retryingScribes} onClick={onRetryPendingScribes}>
						{retryingScribes ? t("正在重新记账…") : t("重新记账")}
					</button>
				</div>
			)}
			{empty && <div className="sp-empty-banner">{t("随剧情展开，时间、地点、登场人物与随身行囊将由场记自动登记入册。")}</div>}
			<section className="sp-section sp-repair-section">
				<div className="sp-section-head"><span className="sp-section-title">{t("状态纠错 Agent")}</span></div>
				<div className="sp-section-body">
					<label className="sp-repair-label" htmlFor="state-repair-instruction">{t("指出账本中记错的事实")}</label>
					<textarea id="state-repair-instruction" maxLength={2000} value={repairInstruction} onChange={(event) => { instructionVersion.current++; setRepairInstruction(event.target.value); setRepairResult(null); }} placeholder={t("例如：怀表已经还给沈舟，请依据剧情修正物品记录。") } />
					<button type="button" className="drawer-btn primary" disabled={repairBusy || !repairInstruction.trim()} onClick={() => void requestRepair()}>{repairBusy ? t("正在核对剧情…") : t("分析并预览修复")}</button>
					{repairResult?.kind === "clarification" && <div className="sp-repair-result" role="status"><strong>{t("需要补充信息")}</strong><p>{repairResult.question}</p><Evidence evidence={repairResult.evidence} /></div>}
					{repairResult?.kind === "proposal" && <div className="sp-repair-result"><strong>{t("修复提案（确认后写入）")}</strong><ul>{repairResult.changes.map((change) => <li key={change.path}><code>{change.path}</code>: <del>{JSON.stringify(change.before)}</del> → <ins>{JSON.stringify(change.after)}</ins></li>)}</ul><Evidence evidence={repairResult.repair.evidence} /><button type="button" className="drawer-btn primary" disabled={repairBusy} onClick={() => void applyRepair()}>{t("确认应用修复")}</button></div>}
					{undoToken && <button type="button" className="drawer-btn" disabled={repairBusy} onClick={() => void undoRepair()}>{t("撤销最近状态修复")}</button>}
					{!undoToken && undoReason && <p className="sp-repair-note">{undoReason}</p>}
				</div>
			</section>

			{/* ── 戏境时空 ── */}
			<section className="sp-section">
				<div className="sp-section-head">
					<span className="sp-section-title">{t("戏境时空")}</span>
				</div>
				<div className="sp-section-body">
					<div className="sp-kv-row">
						<span className="sp-kv-key">{t("纪年时间")}</span>
						<span className="sp-kv-val">
							<Editable value={state?.time ?? ""} placeholder={t("（随剧情自动推进）")} onSave={(v) => patch({ time: v })} />
						</span>
					</div>
					<div className="sp-kv-row">
						<span className="sp-kv-key">{t("当前地点")}</span>
						<span className="sp-kv-val">
							<Editable value={state?.location ?? ""} placeholder={t("（当前场景所在）")} onSave={(v) => patch({ location: v })} />
						</span>
					</div>
				</div>
			</section>

			{/* ── 登场人物与羁绊 ── */}
			<section className="sp-section">
				<div className="sp-section-head">
					<span className="sp-section-title">{t("登场人物羁绊")}</span>
					{characters.length > 0 && <span className="sp-section-badge">{t("{n} 人在案", { n: characters.length })}</span>}
				</div>
				<div className="sp-section-body">
					{characters.length === 0 ? (
						<div className="sp-empty-hint">{t("暂无登场人物记录（随对话自然浮现）")}</div>
					) : (
						<div className="sp-char-stream">
							{characters.map(([name, c]) => (
								<div key={name} className="sp-char-entry">
									<div className="sp-char-meta-row">
										<span className="sp-char-name">{name}</span>
										<div className="sp-char-affinity-group">
											<span className="sp-char-affinity-label">{t("好感")}</span>
											<Editable
												value={String(c.affinity)}
												onSave={(v) => patch({ characters: { [name]: { affinity: num(v, c.affinity) } } })}
											/>
										</div>
										<ConfirmButton
											title={t("移除「{name}」的状态记录", { name })}
											aria-label={t("移除角色记录")}
											confirmText={t("移除")}
											onConfirm={() => patch({ characters: { [name]: null } })}
										>
											<IconTrash size={12} />
										</ConfirmButton>
									</div>
									<div className="affinity-bar" aria-hidden="true">
										<div className="affinity-mid" />
										<div
											className={`affinity-fill ${c.affinity < 0 ? "neg" : ""}`}
											style={
												c.affinity >= 0
													? { left: "50%", width: `${Math.min(50, (c.affinity / 100) * 50)}%` }
													: { right: "50%", width: `${Math.min(50, (-c.affinity / 100) * 50)}%` }
											}
										/>
									</div>
									<div className="sp-char-desc-row">
										<span className="sp-desc-tag">{t("状态")}</span>
										<span className="sp-desc-text">
											<Editable value={c.status} placeholder={t("（当前神态/动作）")} onSave={(v) => patch({ characters: { [name]: { status: v } } })} />
										</span>
									</div>
									<div className="sp-char-desc-row">
										<span className="sp-desc-tag">{t("现处")}</span>
										<span className="sp-desc-text">
											<Editable
												value={c.at ?? ""}
												placeholder={t("（所在地）")}
												onSave={(v) => patch({ characters: { [name]: { at: v } } })}
											/>
										</span>
									</div>
									{c.notes && (
										<div className="sp-char-desc-row sp-notes-row">
											<span className="sp-desc-tag">{t("心境")}</span>
											<span className="sp-desc-text sp-notes-text">
												<Editable value={c.notes} placeholder={t("（心境与暗线）")} onSave={(v) => patch({ characters: { [name]: { notes: v } } })} />
											</span>
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			</section>

			{/* ── 随身行囊 ── */}
			<section className="sp-section">
				<div className="sp-section-head">
					<span className="sp-section-title">{t("随身物品")}</span>
				</div>
				<div className="sp-section-body">
					<div className="sp-kv-row">
						<span className="sp-kv-key">{t("行囊持有")}</span>
						<span className="sp-kv-val">
							<Editable
								value={inventory.join("、")}
								placeholder={t("（无随身器物）")}
								onSave={(v) => patch({ inventory: v.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) })}
							/>
						</span>
					</div>
				</div>
			</section>

			{/* ── 剧情主线与备忘 ── */}
			<section className="sp-section">
				<div className="sp-section-head">
					<span className="sp-section-title">{t("剧情风云线")}</span>
				</div>
				<div className="sp-section-body">
					<Editable
						multiline
						value={plotThreads.join("\n")}
						placeholder={t("（暂无活跃主支线，每行一条）")}
						onSave={(v) => patch({ plot_threads: v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) })}
					/>
				</div>
			</section>

			{/* ── 世态标记 ── */}
			{flags.length > 0 && (
				<section className="sp-section">
					<div className="sp-section-head">
						<span className="sp-section-title">{t("世态标记")}</span>
					</div>
					<div className="sp-section-body">
						{flags.map(([k, v]) => (
							<div key={k} className="sp-kv-row">
								<span className="sp-kv-key">{k}</span>
								<span className="sp-kv-val">
									<Editable value={v} onSave={(nv) => patch({ flags: { [k]: nv } })} />
									<ConfirmButton title={t("删除标记「{k}」", { k })} aria-label={t("删除标记")} confirmText={t("删除")} onConfirm={() => patch({ flags: { [k]: null } })}>
										<IconTrash size={12} />
									</ConfirmButton>
								</span>
							</div>
						))}
					</div>
				</section>
			)}

			<div className="sp-footer-hint">
				{t("数据随剧情自动归卷；点铅笔可随时勘校，改动随当前世界线分支留存与回退。")}
			</div>
		</div>
	);
}
function Evidence({ evidence }: { evidence: RepairEvidence[] }) {
	return <ul className="sp-repair-evidence">{evidence.map((item, index) => <li key={`${item.source}-${index}`}><span>{item.source === "story" ? t("剧情证据") : t("指令依据")}</span>“{item.quote}”</li>)}</ul>;
}
