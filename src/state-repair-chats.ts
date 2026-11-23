import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@liyuan/agent-runtime";
import { t } from "./i18n/index.ts";
import { STATE_REPAIR_INSTRUCTION_MAX, type StateRepairParseResult } from "./state-repair.ts";

export type RepairChatMessage = {
	role: "user" | "assistant";
	text: string;
	thinking?: string;
	proposal?: { token: string; changes: unknown[]; evidence: unknown[]; applied?: boolean; expired?: boolean };
};

export type RepairChat = {
	id: string;
	title: string;
	messages: RepairChatMessage[];
};

const LEGACY_PROPOSAL_TEXT = [
	"已生成状态修改提案，请核对差异与证据后确认应用。",
	"A state-modification proposal is ready. Review the changes and evidence before applying.",
];
const LEGACY_ANSWER_PREFIXES = [
	"只读答复，未生成修改提案。",
	"Read-only answer; no modification proposal was generated.",
];

function normalizeLegacyRepairMessage(message: RepairChatMessage): RepairChatMessage {
	if (message.role !== "assistant") return message;
	if (LEGACY_PROPOSAL_TEXT.includes(message.text) || LEGACY_ANSWER_PREFIXES.includes(message.text)) return { ...message, text: "" };
	for (const prefix of LEGACY_ANSWER_PREFIXES) {
		const fixedPrefix = `${prefix}\n\n`;
		if (message.text.startsWith(fixedPrefix)) return { ...message, text: message.text.slice(fixedPrefix.length) };
	}
	return message;
}

function fileOf(cwd: string, sessionId: string): string {
	return join(cwd, ".liyuan-state", "repair-chats", `${encodeURIComponent(sessionId)}.json`);
}

export function listRepairChats(cwd: string, sessionId: string, newChatTitle: string): RepairChat[] {
	try {
		const raw = JSON.parse(readFileSync(fileOf(cwd, sessionId), "utf8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((chat): chat is RepairChat => !!chat && typeof chat === "object" && typeof (chat as RepairChat).id === "string" && Array.isArray((chat as RepairChat).messages))
			.map((chat) => ({
				id: chat.id,
        title: typeof chat.title === "string" ? chat.title : newChatTitle,
					messages: chat.messages.filter((message): message is RepairChatMessage => !!message && (message.role === "user" || message.role === "assistant") && typeof message.text === "string").map(normalizeLegacyRepairMessage),
			}));
	} catch {
		return [];
	}
}
export function saveRepairChats(cwd: string, sessionId: string, chats: RepairChat[]): void {
	const file = fileOf(cwd, sessionId);
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(chats), { encoding: "utf8", flag: "wx" });
		renameSync(temporary, file);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

export function createRepairChat(cwd: string, sessionId: string, title: string): RepairChat {
  const chat: RepairChat = { id: randomUUID(), title, messages: [] };
  const chats = listRepairChats(cwd, sessionId, title);
  chats.unshift(chat);
  saveRepairChats(cwd, sessionId, chats);
  return chat;
}

export function deleteRepairChat(cwd: string, sessionId: string, id: string, newChatTitle: string): boolean {
  const chats = listRepairChats(cwd, sessionId, newChatTitle);
  if (!chats.some((chat) => chat.id === id)) return false;
  saveRepairChats(cwd, sessionId, chats.filter((chat) => chat.id !== id));
  return true;
}
/** Mark only the matching proposal as applied; returns false if its chat or token disappeared. */
export function markRepairProposalApplied(cwd: string, sessionId: string, chatId: string, token: string, newChatTitle: string): boolean {
  const chats = listRepairChats(cwd, sessionId, newChatTitle);
  const chat = chats.find((item) => item.id === chatId);
  const message = chat?.messages.find((item) => item.proposal?.token === token);
  if (!message?.proposal) return false;
  message.proposal.applied = true;
  saveRepairChats(cwd, sessionId, chats);
  return true;
}

/** Mark a rejected pending proposal expired without changing the conversation. */
export function markRepairProposalExpired(cwd: string, sessionId: string, chatId: string, token: string, newChatTitle: string): boolean {
	const chats = listRepairChats(cwd, sessionId, newChatTitle);
	const message = chats.find((item) => item.id === chatId)?.messages.find((item) => item.proposal?.token === token);
	if (!message?.proposal || message.proposal.applied || message.proposal.expired) return false;
	message.proposal.expired = true;
	saveRepairChats(cwd, sessionId, chats);
	return true;
}

/** Remove only the repair-chat record owned by a deleted parent session file. */
export function deleteRepairChatsForSessionPath(cwd: string, sessionPath: string): void {
  if (!existsSync(sessionPath)) return;
  const sessionId = SessionManager.open(sessionPath, dirname(sessionPath), cwd).getSessionId();
  const file = fileOf(cwd, sessionId);
  if (existsSync(file)) unlinkSync(file);
}

/** Chat edits never undo ledger entries; generation commits history only after success. */
export function createRepairChatHistory(deps: {
  cwd: string;
  getSessionId(): string;
  isStreaming(): boolean;
  newChatTitle(): string;
  invalidateProposal(): void;
  propose(id: string, text: string, history: Array<{ role: "user" | "assistant"; text: string }>, onDelta?: (kind: "thinking" | "text", delta: string) => void): Promise<StateRepairParseResult>;
}) {
  let running = false;
  const assertWritable = (expectedSessionId: string): string => {
    const sessionId = deps.getSessionId();
    if (!expectedSessionId || expectedSessionId !== sessionId) throw new Error(t("扮演会话已切换，请刷新状态修改会话列表后重试。"));
    if (running || deps.isStreaming()) throw new Error(t("当前有生成或记账任务。"));
    return sessionId;
  };
  const readChats = (sessionId: string) => listRepairChats(deps.cwd, sessionId, deps.newChatTitle());
  const requireChat = (chats: RepairChat[], id: string) => {
    const chat = chats.find((item) => item.id === id);
    if (!chat) throw new Error(t("状态修改会话不存在。"));
    return chat;
  };
  const requireUserIndex = (chat: RepairChat, index: number) => {
    if (!Number.isInteger(index) || index < 0 || chat.messages[index]?.role !== "user") throw new Error(t("请选择有效的用户消息。"));
  };
  const expireProposals = (chats: RepairChat[]) => {
    let changed = false;
    for (const chat of chats) for (const message of chat.messages) {
      if (message.proposal && !message.proposal.applied && !message.proposal.expired) {
        message.proposal.expired = true;
        changed = true;
      }
    }
    return changed;
  };
  return {
    isRunning: () => running,
    assertWritable,
    canApplyProposal(id: string, token: string, expectedSessionId: string): boolean {
      const sessionId = assertWritable(expectedSessionId);
      const chat = readChats(sessionId).find((item) => item.id === id);
      return !!chat?.messages.some((message) => message.role === "assistant" && message.proposal?.token === token && !message.proposal.applied && !message.proposal.expired);
    },
    reconcileProposalExpiry(expectedSessionId: string, current: { kind: "busy" | "none" } | { kind: "current"; chatId: string; sessionId: string; token: string }): RepairChat[] {
      const sessionId = deps.getSessionId();
      if (!expectedSessionId || expectedSessionId !== sessionId) throw new Error(t("扮演会话已切换，请刷新状态修改会话列表后重试。"));
      const chats = readChats(sessionId);
      if (running || current.kind === "busy") return chats;
      let changed = false;
      for (const chat of chats) for (const message of chat.messages) {
        if (!message.proposal || message.proposal.applied || message.proposal.expired) continue;
        if (current.kind !== "current" || current.sessionId !== sessionId || current.chatId !== chat.id || current.token !== message.proposal.token) {
          message.proposal.expired = true;
          changed = true;
        }
      }
      if (changed) saveRepairChats(deps.cwd, sessionId, chats);
      return chats;
    },
    rewindRepairChat(id: string, index: number, expectedSessionId: string): { chat: RepairChat } {
      const sessionId = assertWritable(expectedSessionId);
      const chats = readChats(sessionId);
      const chat = requireChat(chats, id);
      requireUserIndex(chat, index);
      chat.messages = chat.messages.slice(0, index);
      expireProposals(chats);
      saveRepairChats(deps.cwd, sessionId, chats);
      deps.invalidateProposal();
      return { chat };
    },
    async repairTurn(id: string, text: string, expectedSessionId: string, onDelta?: (kind: "thinking" | "text", delta: string) => void, index?: number): Promise<{ chat: RepairChat } | { kind: "invalid"; reason: string }> {
      const sessionId = assertWritable(expectedSessionId);
      const chats = readChats(sessionId);
      const chat = requireChat(chats, id);
      const message = text.trim();
      if (!message || message.length > STATE_REPAIR_INSTRUCTION_MAX) throw new Error(t("请填写 1–{max} 字符的状态修改说明。", { max: STATE_REPAIR_INSTRUCTION_MAX }));
      if (index !== undefined) requireUserIndex(chat, index);
      // Stage holds a single live proposal across chats. Expiry survives failures/reloads.
      if (expireProposals(chats)) saveRepairChats(deps.cwd, sessionId, chats);
      deps.invalidateProposal();
      const baseline = JSON.stringify(chat.messages);
      const messages = chat.messages.slice(0, index ?? chat.messages.length);
      messages.push({ role: "user", text: message });
      const history = messages.map(({ role, text }) => ({ role, text }));
      let thinking = "";
      let committed = false;
      running = true;
      try {
        const result = await deps.propose(id, message, history, (kind, delta) => {
          if (kind === "thinking") thinking += delta;
          onDelta?.(kind, delta);
        });
        if (result.kind === "invalid") return result;
        if (deps.getSessionId() !== sessionId) return { kind: "invalid", reason: t("剧情会话已切换，本次提案未保存。") };
        const latest = readChats(sessionId);
        const target = latest.find((item) => item.id === id);
        if (!target) return { kind: "invalid", reason: t("状态修改会话已删除，本次提案未保存。") };
        if (JSON.stringify(target.messages) !== baseline) return { kind: "invalid", reason: t("状态修改会话已变化，本次提案未保存，请刷新后重试。") };
        const assistantThinking = thinking ? { thinking } : {};
        if (result.kind === "proposal") {
          const token = (result as typeof result & { token?: string }).token;
          if (typeof token !== "string" || !token) return { kind: "invalid", reason: t("修复提案已失效，请重新分析。") };
          messages.push({ role: "assistant", text: "", ...assistantThinking, proposal: { token, changes: result.changes, evidence: result.repair.evidence } });
        } else {
          messages.push({ role: "assistant", text: result.kind === "clarification" ? result.question : result.text, ...assistantThinking });
        }
        target.messages = messages;
        if (messages.length === 2 && target.title === deps.newChatTitle()) target.title = message.slice(0, 48);
        saveRepairChats(deps.cwd, sessionId, latest);
        committed = true;
        return { chat: target };
      } finally {
        if (!committed) deps.invalidateProposal();
        running = false;
      }
    },
  };
}
