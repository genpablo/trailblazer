import { useEffect, useRef, useState } from "preact/hooks";
import { type Citation, fetchConfig, fetchHistory, type PublicBotConfig, streamChat } from "./api";
import { Markdown } from "./markdown";
import { conversationStore, languageStore, visitorId } from "./storage";
import { ui } from "./strings";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  pending?: boolean;
  error?: boolean;
}

export interface AppProps {
  publicKey: string;
  /** "hosted" (full page), "inline" (iframe in a page), "widget" (floating panel), "playground" (admin). */
  mode: "hosted" | "inline" | "widget" | "playground";
  pageUrl: string | null;
}

let counter = 0;
const nextId = () => `m${++counter}`;

function pickLanguage(config: PublicBotConfig, publicKey: string): string {
  const codes = config.languages.map((l) => l.code);
  const saved = languageStore.get(publicKey);
  if (saved && codes.includes(saved)) return saved;
  for (const tag of navigator.languages ?? []) {
    const lower = tag.toLowerCase();
    const base = lower.split("-")[0]!;
    const zh = base === "zh" ? (/(tw|hk|mo|hant)/.test(lower) ? "zh-Hant" : "zh-Hans") : null;
    const match = codes.find((c) => c.toLowerCase() === (zh ?? base).toLowerCase());
    if (match) return match;
  }
  return config.defaultLanguage;
}

export function App({ publicKey, mode, pageUrl }: AppProps) {
  const [config, setConfig] = useState<PublicBotConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [lang, setLang] = useState("en");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const conversationId = useRef<string | null>(conversationStore.get(publicKey));
  const visitor = useRef(visitorId(publicKey));
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchConfig(publicKey)
      .then(async (cfg) => {
        setConfig(cfg);
        setLang(pickLanguage(cfg, publicKey));
        if (conversationId.current) {
          const history = await fetchHistory(publicKey, conversationId.current, visitor.current);
          if (history.length) {
            setMessages(
              history.map((m) => ({
                id: nextId(),
                role: m.role,
                content: m.content,
                citations: m.citations,
              })),
            );
          } else {
            conversationId.current = null;
            conversationStore.set(publicKey, null);
          }
        }
      })
      .catch(() => setFailed(true));
  }, [publicKey]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  const language = config?.languages.find((l) => l.code === lang);
  const dir = language?.dir ?? "ltr";

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    if (config) document.title = config.businessName;
  }, [lang, dir, config]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !config) return;
    setInput("");
    setBusy(true);
    const assistantId = nextId();
    setMessages((list) => [
      ...list,
      { id: nextId(), role: "user", content: message, citations: [] },
      { id: assistantId, role: "assistant", content: "", citations: [], pending: true },
    ]);
    const update = (fn: (m: Message) => Message) =>
      setMessages((list) => list.map((m) => (m.id === assistantId ? fn(m) : m)));

    try {
      for await (const event of streamChat({
        publicKey,
        conversationId: conversationId.current,
        visitorId: visitor.current,
        message,
        channel: mode,
        pageUrl,
      })) {
        if (event.type === "start") {
          conversationId.current = event.conversationId;
          conversationStore.set(publicKey, event.conversationId);
        } else if (event.type === "text") {
          update((m) => ({ ...m, content: m.content + event.text }));
        } else if (event.type === "done") {
          update((m) => ({ ...m, pending: false, citations: event.citations }));
        } else {
          update((m) => ({
            ...m,
            pending: false,
            error: true,
            content: ui(lang, event.code === "unavailable" ? "unavailable" : "error"),
          }));
        }
      }
    } catch {
      update((m) => ({ ...m, pending: false, error: true, content: m.content || ui(lang, "error") }));
    } finally {
      update((m) => ({ ...m, pending: false }));
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function newConversation() {
    conversationId.current = null;
    conversationStore.set(publicKey, null);
    setMessages([]);
    inputRef.current?.focus();
  }

  function changeLanguage(code: string) {
    setLang(code);
    languageStore.set(publicKey, code);
  }

  function onKeyDown(event: KeyboardEvent) {
    // Don't send while an input method (Chinese, Japanese, Hindi…) is composing text.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void send(input);
    }
  }

  if (failed) {
    return (
      <div class="tb-shell" data-mode={mode}>
        <p class="tb-empty">{ui(lang, "unavailable")}</p>
      </div>
    );
  }
  if (!config) return <div class="tb-shell" data-mode={mode} aria-busy="true" />;

  const greeting = config.greeting[lang] ?? ui(lang, "greeting", { business: config.businessName });
  const quickReplies = config.quickReplies[lang] ?? config.quickReplies[lang === "fr" ? "fr" : "en"] ?? [];
  const brand = config.color ?? "#1f6f5c";

  return (
    <div class="tb-shell" data-mode={mode} dir={dir} style={{ "--tb-brand": brand }}>
      <header class="tb-header">
        <div class="tb-title">
          <strong>{config.businessName}</strong>
        </div>
        <div class="tb-header-actions">
          {config.languages.length > 1 && (
            <select
              class="tb-lang"
              aria-label={ui(lang, "language")}
              value={lang}
              onChange={(e) => changeLanguage((e.target as HTMLSelectElement).value)}
            >
              {config.languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.nativeName}
                </option>
              ))}
            </select>
          )}
          {messages.length > 0 && (
            <button
              type="button"
              class="tb-icon"
              onClick={newConversation}
              aria-label={ui(lang, "newChat")}
              title={ui(lang, "newChat")}
            >
              ↺
            </button>
          )}
          {mode === "widget" && (
            <button
              type="button"
              class="tb-icon"
              aria-label={ui(lang, "close")}
              onClick={() => window.parent.postMessage({ type: "tb:close" }, "*")}
            >
              ×
            </button>
          )}
        </div>
      </header>

      <div class="tb-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions">
        <div class="tb-msg tb-assistant" dir="auto">
          <Markdown text={greeting} />
        </div>
        {messages.map((m) => (
          <div key={m.id} class={`tb-msg tb-${m.role}${m.error ? " tb-error" : ""}`} dir="auto">
            {m.role === "assistant" ? (
              m.content ? (
                <Markdown text={m.content} />
              ) : (
                <span class="tb-typing" role="img" aria-label={ui(lang, "thinking")}>
                  <i />
                  <i />
                  <i />
                </span>
              )
            ) : (
              <p>{m.content}</p>
            )}
            {!m.pending && m.citations.length > 0 && (
              <div class="tb-sources">
                <span>{ui(lang, "sources")}:</span>
                {m.citations.map((c) =>
                  c.url ? (
                    <a key={c.url} href={c.url} target="_blank" rel="noopener noreferrer nofollow">
                      {c.title ?? new URL(c.url).pathname}
                    </a>
                  ) : null,
                )}
              </div>
            )}
          </div>
        ))}
        {messages.length === 0 && quickReplies.length > 0 && (
          <div class="tb-chips">
            {quickReplies.map((q) => (
              <button key={q} type="button" class="tb-chip" onClick={() => void send(q)} dir="auto">
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      <form
        class="tb-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          dir="auto"
          maxLength={2000}
          value={input}
          placeholder={ui(lang, "placeholder")}
          aria-label={ui(lang, "placeholder")}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" class="tb-send" disabled={busy || !input.trim()} aria-label={ui(lang, "send")}>
          {dir === "rtl" ? "←" : "→"}
        </button>
      </form>
      <footer class="tb-footer">
        <span>{ui(lang, "disclaimer")}</span>
        {config.poweredBy && <span>{ui(lang, "poweredBy")}</span>}
      </footer>
    </div>
  );
}
