import { paletteFor } from "@traiblazer/appearance";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "./Avatar";
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
  /** A limit or "busy" message (not an error). */
  notice?: boolean;
}

/** Friendly text for a refused question, with the business's contact details where helpful. */
function refusalText(code: string, lang: string, config: PublicBotConfig): string | null {
  const business = config.businessName;
  // Rendered as a short list by the Markdown component.
  const contact = [
    config.contact.phone && `- ${ui(lang, "phone")}: ${config.contact.phone}`,
    config.contact.email && `- ${ui(lang, "email")}: ${config.contact.email}`,
  ]
    .filter(Boolean)
    .join("\n");
  const withContact = (text: string) => (contact ? `${text}\n\n${contact}` : text);
  switch (code) {
    case "quota":
      return withContact(ui(lang, "limitQuota", { business }));
    case "visitor":
      return withContact(ui(lang, "limitVisitor", { business }));
    case "conversation":
      return ui(lang, "limitConversation");
    case "busy":
      return ui(lang, "busy");
    case "slowDown":
      return ui(lang, "slowDown");
    default:
      return null;
  }
}

export interface AppProps {
  publicKey: string;
  /** "hosted" (full page), "inline" (iframe in a page), "widget" (floating panel), "playground" (admin). */
  mode: "hosted" | "inline" | "widget" | "playground";
  pageUrl: string | null;
  /** Admin preview: looks like `mode`, but conversations are logged as playground tests. */
  preview?: boolean;
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

export function App({ publicKey, mode, pageUrl, preview = false }: AppProps) {
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
        channel: preview ? "playground" : mode,
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
          const notice = refusalText(event.code, lang, config);
          update((m) => ({
            ...m,
            pending: false,
            // Limits and "busy" are expected situations, shown as a calm notice rather than an error.
            notice: Boolean(notice),
            error: !notice,
            content: notice ?? ui(lang, event.code === "unavailable" ? "unavailable" : "error"),
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

  const { appearance } = config;
  const named = appearance.assistantName !== config.businessName;
  const greeting =
    config.greeting[lang] ??
    (named
      ? ui(lang, "greetingNamed", { name: appearance.assistantName, business: config.businessName })
      : ui(lang, "greeting", { business: config.businessName }));
  const quickReplies = config.quickReplies[lang] ?? config.quickReplies[lang === "fr" ? "fr" : "en"] ?? [];
  const palette = paletteFor(appearance.color, appearance.theme);
  const avatarBesideReplies = appearance.theme === "friendly" || appearance.theme === "bold";

  const assistantRow = (key: string | undefined, className: string, children: ComponentChildren) =>
    avatarBesideReplies ? (
      <div key={key} class="tb-row">
        <Avatar avatar={appearance.avatar} size={28} />
        <div class={className} dir="auto">
          {children}
        </div>
      </div>
    ) : (
      <div key={key} class={className} dir="auto">
        {children}
      </div>
    );

  return (
    <div
      class="tb-shell"
      data-mode={mode}
      data-theme={appearance.theme}
      dir={dir}
      style={{
        "--tb-brand": palette.brand,
        "--tb-on-brand": palette.onBrand,
        "--tb-accent": palette.accent,
      }}
    >
      <header class="tb-header">
        <div class="tb-title">
          <Avatar avatar={appearance.avatar} size={appearance.theme === "bold" ? 52 : 36} />
          <div class="tb-names">
            <strong dir="auto">{appearance.assistantName}</strong>
            {named && (
              <span class="tb-subtitle" dir="auto">
                {config.businessName}
              </span>
            )}
          </div>
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
        {assistantRow(undefined, "tb-msg tb-assistant", <Markdown text={greeting} />)}
        {messages.map((m) => {
          const className = `tb-msg tb-${m.role}${m.error ? " tb-error" : ""}${m.notice ? " tb-notice" : ""}`;
          if (m.role === "user") {
            return (
              <div key={m.id} class={className} dir="auto">
                <p>{m.content}</p>
              </div>
            );
          }
          return assistantRow(
            m.id,
            className,
            <>
              {m.content ? (
                <Markdown text={m.content} />
              ) : (
                <span class="tb-typing" role="img" aria-label={ui(lang, "thinking")}>
                  <i />
                  <i />
                  <i />
                </span>
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
            </>,
          );
        })}
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
