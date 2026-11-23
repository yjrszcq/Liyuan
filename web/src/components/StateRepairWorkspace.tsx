import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { apiDelete, apiGet, apiPost } from "../api.ts";
import { t } from "../i18n/index.ts";
import { renderMarkdown } from "./ArtifactPanel.tsx";
import { IconChevronDown, IconClose } from "./icons.tsx";

type Change = { path: string; before: unknown; after: unknown };
type Evidence = { source: string; quote: string };
type Proposal = { token: string; changes: Change[]; evidence: Evidence[] };
type RepairMessage = { role: "user" | "assistant"; text: string; proposal?: Proposal };
type RepairChat = { id: string; title: string; messages: RepairMessage[] };

export function StateRepairWorkspace({ sessionId, setInput, sendRef, toast, onExit, onApplied }: {
  sessionId: string;
  setInput: (text: string) => void;
  sendRef: MutableRefObject<((text: string) => Promise<void>) | null>;
  toast: (level: "info" | "warning" | "error", text: string) => void;
  onExit: () => void;
  onApplied: () => void;
}) {
  const [chats, setChats] = useState<RepairChat[]>([]);
  const [chatId, setChatId] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const [header, setHeader] = useState<Element | null>(null);
  useEffect(() => { setHeader(workspaceRef.current?.closest(".stage-col")?.querySelector(".stage-col-head") ?? null); }, []);
  const epoch = useRef(0);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const activeChat = chats.find((chat) => chat.id === chatId);
  const refresh = async (version: number) => {
    const result = await apiGet<{ chats: RepairChat[] }>("/api/state/repair/chats", { bypassCache: true });
    if (epoch.current !== version) return;
    setChats(result.chats);
    if (!result.chats.some((chat) => chat.id === chatId)) setChatId(result.chats[0]?.id ?? "");
  };
  useEffect(() => {
    const version = ++epoch.current;
    setChats([]); setChatId(""); setInput(""); setBusy(true);
    void refresh(version).catch((error) => { if (epoch.current === version) toast("error", String(error)); })
      .finally(() => { if (epoch.current === version) setBusy(false); });
    return () => { epoch.current++; };
  }, [sessionId]);
  const deleteChat = async (id: string) => {
    const version = epoch.current;
    const parentSessionId = sessionId;
    try {
      await apiDelete(`/api/state/repair/chats?id=${encodeURIComponent(id)}&sessionId=${encodeURIComponent(parentSessionId)}`);
      if (epoch.current !== version) return;
      const remaining = chats.filter((chat) => chat.id !== id);
      setChats(remaining);
      if (chatIdRef.current === id) setChatId(remaining[0]?.id ?? "");
    } catch (error) { if (epoch.current === version) toast("error", error instanceof Error ? error.message : String(error)); }
  };
  const submit = async (text: string) => {
    if (!text.trim() || busy) return;
    const version = epoch.current;
    const parentSessionId = sessionId;
    let id = chatId;
    setBusy(true);
    try {
      if (!id) {
        const created = await apiPost<{ chat: RepairChat }>("/api/state/repair/chats", { sessionId: parentSessionId });
        if (epoch.current !== version) return;
        id = created.chat.id;
        setChats((items) => [...items, created.chat]);
        if (!chatIdRef.current) { chatIdRef.current = id; setChatId(id); }
      }
      const result = await apiPost<{ chat: RepairChat }>("/api/state/repair/turn", { id, text: text.trim(), sessionId: parentSessionId });
      if (epoch.current !== version) return;
      setChats((items) => items.map((chat) => chat.id === id ? result.chat : chat));
      if (chatIdRef.current === id) setInput("");
    } catch (error) { if (epoch.current === version) toast("error", error instanceof Error ? error.message : String(error)); }
    finally { if (epoch.current === version) setBusy(false); }
  };
  sendRef.current = submit;
  const apply = async (token: string) => {
    const id = chatId; const version = epoch.current; const parentSessionId = sessionId;
    setBusy(true);
    try {
      const result = await apiPost<{ ok: boolean; reason?: string; warning?: boolean }>("/api/state/repair/apply", { id, token, sessionId: parentSessionId });
      if (epoch.current !== version || id !== chatIdRef.current) return;
      if (!result.ok) toast("warning", result.reason ?? t("修复提案已失效"));
      else { toast(result.warning ? "warning" : "info", result.warning ? t("修复已写入分支但缓存更新失败") : t("状态修复已写入当前分支")); onApplied(); }
    } catch (error) { if (epoch.current === version) toast("error", error instanceof Error ? error.message : String(error)); }
    finally { if (epoch.current === version) setBusy(false); }
  };
  return <section ref={workspaceRef} className="repair-workspace" aria-label={t("状态修改工作区")}>
    {header && createPortal(<div className="repair-head">
      <button type="button" className={`repair-current-chat wb-nav-more-btn ${pickerOpen ? "expanded" : ""}`} onClick={() => setPickerOpen((open) => !open)} aria-expanded={pickerOpen}>{activeChat?.title || (activeChat ? t("未命名会话") : t("新建修改会话"))}<IconChevronDown size={14} className="wb-nav-more-caret" /></button>
      {pickerOpen && <div className="repair-chat-picker"><div className="repair-chat-option"><button type="button" disabled={busy} onClick={() => { chatIdRef.current = ""; setChatId(""); setPickerOpen(false); }}>{t("新建修改会话")}</button></div>{chats.map((chat) => <div className="repair-chat-option" key={chat.id}><button type="button" onClick={() => { chatIdRef.current = chat.id; setChatId(chat.id); setPickerOpen(false); }}>{chat.title || t("未命名会话")}</button><button type="button" aria-label={t("删除此修改会话")} onClick={() => { if (window.confirm(t("删除这段状态修改对话？已写入账本的改动不会撤销。"))) void deleteChat(chat.id); }}>×</button></div>)}</div>}
      <button type="button" className="icon-btn" onClick={onExit} title={t("返回剧情")} aria-label={t("返回剧情")}><IconClose size={15} /></button>
    </div>, header)}
    <div className="repair-messages">
      {activeChat?.messages.map((message, index) => <article key={`${activeChat.id}-${index}`} className={`repair-message repair-${message.role}`}>
        <div className="repair-message-text">{message.role === "assistant" ? renderMarkdown(message.text) : message.text}</div>
        {message.proposal && <section className="repair-proposal"><strong>{t("待确认的状态提案")}</strong><ul>{message.proposal.changes.map((change, i) => <li key={`${change.path}-${i}`}><code>{change.path}</code><div><del>{JSON.stringify(change.before)}</del><span> → </span><ins>{JSON.stringify(change.after)}</ins></div></li>)}</ul>
          {message.proposal.evidence?.length > 0 && <div className="repair-evidence"><strong>{t("依据")}</strong>{message.proposal.evidence.map((item, i) => <blockquote key={i}><span>{item.source === "story" ? t("剧情证据") : item.source === "instruction" ? t("指令依据") : item.source}</span>{item.quote}</blockquote>)}</div>}
          <button className="drawer-btn primary" type="button" disabled={busy} onClick={() => void apply(message.proposal!.token)}>{t("确认应用修改")}</button></section>}
      </article>)}
      {busy && <div className="info-line pulse">{t("正在核对剧情…")}</div>}
    </div>
  </section>;
}
