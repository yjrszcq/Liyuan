import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.ts";
import { t } from "../i18n/index.ts";
import { renderMarkdown } from "./ArtifactPanel.tsx";
import { ThinkingBlock } from "./Messages.tsx";
import { IconChevronDown, IconClose, IconCopy, IconPencil, IconRefresh, IconUndo } from "./icons.tsx";

type Change = { path: string; before: unknown; after: unknown };
type Evidence = { source: string; quote: string };
type Proposal = { token: string; changes: Change[]; evidence: Evidence[]; applied?: boolean; expired?: boolean };
type RepairMessage = { role: "user" | "assistant"; text: string; thinking?: string; proposal?: Proposal };
type RepairChat = { id: string; title: string; messages: RepairMessage[] };

function expirePendingProposals(chats: RepairChat[]): RepairChat[] {
  return chats.map((chat) => ({ ...chat, messages: chat.messages.map((message) => message.proposal && !message.proposal.applied && !message.proposal.expired ? { ...message, proposal: { ...message.proposal, expired: true } } : message) }));
}

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
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [pending, setPending] = useState<{ id: string; text: string; thinking: string; reply: string } | null>(null);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
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
    setChats([]); setChatId(""); setInput(""); setBusy(true); setRenaming(null); setPickerOpen(false); setPending(null); setEditing(null);
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
  const renameChat = async () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    if (!title) { setRenaming(null); return; }
    const version = epoch.current;
    setBusy(true);
    try {
      const result = await apiPut<{ chat: RepairChat }>("/api/state/repair/chats", { id: renaming.id, title, sessionId });
      if (epoch.current !== version) return;
      setChats((items) => items.map((chat) => chat.id === result.chat.id ? result.chat : chat));
      setRenaming(null);
    } catch (error) { if (epoch.current === version) toast("error", error instanceof Error ? error.message : String(error)); }
    finally { if (epoch.current === version) setBusy(false); }
  };
  const submit = async (text: string, index?: number) => {
    const message = text.trim();
    if (!message || busy) return;
    const version = epoch.current;
    const parentSessionId = sessionId;
    let id = chatId;
    setPending({ id, text: message, thinking: "", reply: "" });
    setInput("");
    setBusy(true);
    try {
      if (!id) {
        const created = await apiPost<{ chat: RepairChat }>("/api/state/repair/chats", { sessionId: parentSessionId });
        if (epoch.current !== version) return;
        id = created.chat.id;
        setChats((items) => [...items, created.chat]);
        setPending((item) => item ? { ...item, id } : item);
        if (!chatIdRef.current) { chatIdRef.current = id; setChatId(id); }
      }
      const response = await fetch("/api/state/repair/turn/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, text: message, sessionId: parentSessionId, ...(index === undefined ? {} : { index }) }) });
      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || t("请求失败（HTTP {status}）", { status: response.status }));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: { chat?: RepairChat; reason?: string } | undefined;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as { type: string; kind?: string; delta?: string; result?: { chat?: RepairChat; reason?: string }; error?: string };
          if (event.type === "error") throw new Error(event.error);
          if (event.type === "result") result = event.result;
          if (event.type === "delta" && event.delta && epoch.current === version) {
            const delta = event.delta;
            setPending((item) => item && item.id === id ? { ...item, ...(event.kind === "thinking" ? { thinking: item.thinking + delta } : { reply: item.reply + delta }) } : item);
          }
        }
        if (done) break;
      }
      if (!result?.chat) throw new Error(result?.reason || t("修复提案已失效"));
      if (epoch.current !== version) return;
      setChats((items) => expirePendingProposals(items).map((chat) => chat.id === id ? result!.chat! : chat));
    } catch (error) {
      if (epoch.current === version) {
        toast("error", error instanceof Error ? error.message : String(error));
        try { await refresh(version); } catch { /* Preserve the visible error. */ }
      }
    } finally { if (epoch.current === version) { setPending(null); setBusy(false); } }
  };
  const rewind = async (index: number) => {
    const id = chatId;
    const version = epoch.current;
    const parentSessionId = sessionId;
    if (!id || busy || !window.confirm(t("回退至此消息前？该消息及后续内容将被截断，已应用的账本修改不会撤销。"))) return;
    setBusy(true);
    try {
      const result = await apiPost<{ chat: RepairChat }>("/api/state/repair/rewind", { id, sessionId: parentSessionId, index });
      if (epoch.current !== version || id !== chatIdRef.current) return;
      setChats((items) => expirePendingProposals(items).map((chat) => chat.id === id ? result.chat : chat));
      setEditing(null);
      toast("info", t("已回退；后续对话已截断，已应用的账本修改不变。"));
    } catch (error) { if (epoch.current === version) toast("error", error instanceof Error ? error.message : String(error)); }
    finally { if (epoch.current === version) setBusy(false); }
  };
  const copyMessage = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast("info", t("已复制正文")); }
    catch { toast("error", t("复制失败（浏览器限制）")); }
  };
  const confirmEdit = () => {
    if (!editing || busy) return;
    const { index, text } = editing;
    if (!text.trim() || !window.confirm(t("修改此用户消息并重新生成？该消息及后续内容将被截断，已应用的账本修改不会撤销。"))) return;
    setEditing(null);
    void submit(text, index);
  };
  sendRef.current = submit;
  const apply = async (token: string) => {
    const id = chatId; const version = epoch.current; const parentSessionId = sessionId;
    setBusy(true);
    try {
      const result = await apiPost<{ ok: boolean; reason?: string; expired?: boolean; warning?: boolean; appliedSaveFailed?: boolean }>("/api/state/repair/apply", { id, token, sessionId: parentSessionId });
      if (epoch.current !== version || id !== chatIdRef.current) return;
      if (!result.ok) {
        if (result.expired) setChats((items) => items.map((chat) => chat.id !== id ? chat : { ...chat, messages: chat.messages.map((message) => message.proposal?.token === token ? { ...message, proposal: { ...message.proposal, expired: true } } : message) }));
        toast("warning", result.reason ?? t("修复提案已失效"));
      }
      else {
        setChats((items) => items.map((chat) => chat.id !== id ? chat : { ...chat, messages: chat.messages.map((message) => message.proposal?.token === token ? { ...message, proposal: { ...message.proposal, applied: true } } : message) }));
        if (result.appliedSaveFailed) toast("warning", t("修改已写入分支，但已应用标记保存失败"));
        if (result.warning) toast("warning", t("修复已写入分支但缓存更新失败"));
        if (!result.appliedSaveFailed && !result.warning) toast("info", t("状态修复已写入当前分支"));
        onApplied();
      }
    } catch (error) { if (epoch.current === version) toast("error", error instanceof Error ? error.message : String(error)); }
    finally { if (epoch.current === version) setBusy(false); }
  };
  return <section ref={workspaceRef} className="repair-workspace" aria-label={t("状态修改工作区")}>
    {header && createPortal(<div className="repair-head">
      <button type="button" className={`repair-current-chat wb-nav-more-btn ${pickerOpen ? "expanded" : ""}`} onClick={() => { setPickerOpen((open) => !open); setRenaming(null); }} aria-expanded={pickerOpen}>{activeChat?.title || (activeChat ? t("未命名会话") : t("新建修改会话"))}<IconChevronDown size={14} className="wb-nav-more-caret" /></button>
      {pickerOpen && <div className="repair-chat-picker"><div className="repair-chat-option"><button type="button" disabled={busy} onClick={() => { chatIdRef.current = ""; setChatId(""); setEditing(null); setPickerOpen(false); }}>{t("新建修改会话")}</button></div>{chats.map((chat) => <div className="repair-chat-option" key={chat.id}>
        {renaming?.id === chat.id ? <input autoFocus className="repair-chat-rename" aria-label={t("重命名对话")} value={renaming.title} disabled={busy} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setRenaming({ id: chat.id, title: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void renameChat(); } else if (e.key === "Escape") setRenaming(null); }} onBlur={() => { if (!busy) setRenaming(null); }} /> : <button type="button" disabled={busy} onClick={() => { chatIdRef.current = chat.id; setChatId(chat.id); setEditing(null); setPickerOpen(false); }}>{chat.title || t("未命名会话")}</button>}
        <button type="button" disabled={busy} title={t("重命名")} aria-label={t("重命名对话")} onMouseDown={(e) => e.preventDefault()} onClick={() => setRenaming({ id: chat.id, title: chat.title })}><IconPencil size={14} /></button>
        <button type="button" disabled={busy} aria-label={t("删除此修改会话")} onClick={() => { if (window.confirm(t("删除这段状态修改对话？已写入账本的改动不会撤销。"))) void deleteChat(chat.id); }}>×</button>
      </div>)}</div>}
      <button type="button" className="icon-btn" onClick={onExit} title={t("返回剧情")} aria-label={t("返回剧情")}><IconClose size={15} /></button>
    </div>, header)}
    <div className="repair-messages">
      {activeChat?.messages.map((message, index) => {
        let sourceUserIndex = -1;
        for (let i = index; i >= 0; i--) if (activeChat.messages[i].role === "user") { sourceUserIndex = i; break; }
        return <div key={`${activeChat.id}-${index}`} className={`repair-message-row repair-row-${message.role}`}>
        <article className={`repair-message repair-${message.role}`}>
        {message.thinking && <ThinkingBlock text={message.thinking} />}
        {editing?.index === index && message.role === "user" ? <textarea autoFocus className="repair-edit-input" value={editing.text} disabled={busy} onChange={(event) => setEditing({ index, text: event.target.value })} /> : message.text && <div className="repair-message-text">{message.role === "assistant" ? renderMarkdown(message.text) : message.text}</div>}
        {message.proposal && <section className="repair-proposal"><strong>{t("待确认的状态提案")}</strong><ul>{message.proposal.changes.map((change, i) => <li key={`${change.path}-${i}`}><code>{change.path}</code><div><del>{JSON.stringify(change.before)}</del><span> → </span><ins>{JSON.stringify(change.after)}</ins></div></li>)}</ul>
          {message.proposal.evidence?.length > 0 && <div className="repair-evidence"><strong>{t("依据")}</strong>{message.proposal.evidence.map((item, i) => <blockquote key={i}><span>{item.source === "story" ? t("剧情证据") : item.source === "instruction" ? t("指令依据") : item.source}</span>{item.quote}</blockquote>)}</div>}
          <button className="drawer-btn primary" type="button" disabled={busy || message.proposal.applied || message.proposal.expired} onClick={() => void apply(message.proposal!.token)}>{message.proposal.applied ? t("已应用") : message.proposal.expired ? t("已失效") : t("确认应用修改")}</button></section>}
      </article>
        <div className="repair-message-actions">
          {message.text && <button type="button" className="repair-action repair-icon-action" title={t("复制")} aria-label={t("复制")} disabled={busy} onClick={() => void copyMessage(message.text)}><IconCopy size={16} /></button>}
          {message.role === "user" ? editing?.index === index ? <>
            <button type="button" className="repair-action" disabled={busy || !editing.text.trim()} onClick={confirmEdit}>{t("确认修改并重新生成")}</button>
            <button type="button" className="repair-action" disabled={busy} onClick={() => setEditing(null)}>{t("取消")}</button>
          </> : <>
            <button type="button" className="repair-action repair-icon-action" title={t("修改并重新生成")} aria-label={t("修改并重新生成")} disabled={busy} onClick={() => setEditing({ index, text: message.text })}><IconPencil size={16} /></button>
            <button type="button" className="repair-action repair-icon-action" title={t("回退到此消息前")} aria-label={t("回退到此消息前")} disabled={busy} onClick={() => void rewind(index)}><IconUndo size={16} /></button>
          </> : sourceUserIndex >= 0 && <button type="button" className="repair-action repair-icon-action" title={t("重新生成")} aria-label={t("重新生成")} disabled={busy} onClick={() => { if (window.confirm(t("重新生成此回复？该回复及后续对话将被截断，已应用的账本修改不会撤销。"))) void submit(activeChat.messages[sourceUserIndex].text, sourceUserIndex); }}><IconRefresh size={16} /></button>}
        </div>
      </div>; })}
      {pending && pending.id === chatId && <>
        <article className="repair-message repair-user"><div className="repair-message-text">{pending.text}</div></article>
        <article className="repair-message repair-assistant">
          {pending.thinking && <ThinkingBlock text={pending.thinking} live={!pending.reply} />}
          {pending.reply ? <details className="thinking"><summary>{t("回复")}</summary><div className="thinking-body">{pending.reply}</div></details> : <div className="info-line pulse">{t("正在核对剧情…")}</div>}
        </article>
      </>}
    </div>
  </section>;
}
