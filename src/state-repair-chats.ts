import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@liyuan/agent-runtime";

export type RepairChatMessage = {
	role: "user" | "assistant";
	text: string;
	proposal?: { token: string; changes: unknown[]; evidence: unknown[] };
};

export type RepairChat = {
	id: string;
	title: string;
	messages: RepairChatMessage[];
};

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
					messages: chat.messages.filter((message): message is RepairChatMessage => !!message && (message.role === "user" || message.role === "assistant") && typeof message.text === "string"),
			}));
	} catch {
		return [];
	}
}
export function saveRepairChats(cwd: string, sessionId: string, chats: RepairChat[]): void {
	const file = fileOf(cwd, sessionId);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(chats), "utf8");
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

/** Remove only the repair-chat record owned by a deleted parent session file. */
export function deleteRepairChatsForSessionPath(cwd: string, sessionPath: string): void {
  if (!existsSync(sessionPath)) return;
  const sessionId = SessionManager.open(sessionPath, dirname(sessionPath), cwd).getSessionId();
  const file = fileOf(cwd, sessionId);
  if (existsSync(file)) unlinkSync(file);
}
