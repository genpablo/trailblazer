"use client";

import { useEffect, useState } from "react";
import { api, type Conversation, type ConversationMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export function ConversationsTab({ base }: { base: string }) {
  const { t, language } = useI18n();
  const [list, setList] = useState<Conversation[] | null>(null);
  const [open, setOpen] = useState<{ id: string; messages: ConversationMessage[] } | null>(null);

  useEffect(() => {
    void api<{ conversations: Conversation[] }>(`${base}/conversations`).then((d) =>
      setList(d.conversations),
    );
  }, [base]);

  async function show(id: string) {
    const data = await api<{ messages: ConversationMessage[] }>(`${base}/conversations/${id}`);
    setOpen({ id, messages: data.messages });
  }

  if (list === null) return <p className="muted text-sm">{t("common.loading")}</p>;
  if (!list.length) return <p className="muted text-sm">{t("conversations.empty")}</p>;

  const fmt = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {list.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className={`w-full py-2 text-start text-sm ${open?.id === c.id ? "font-semibold" : ""}`}
              onClick={() => show(c.id)}
            >
              {fmt.format(new Date(c.lastMessageAt))}
              <span className="muted block text-xs">
                {c.channel} · {c.language ?? "?"} · {t("conversations.messages", { count: c.messageCount })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div className="flex flex-col gap-2">
          {open.messages.map((m) => (
            <div
              key={m.id}
              dir="auto"
              className={`rounded-lg p-3 text-sm whitespace-pre-wrap ${m.role === "user" ? "self-end bg-[var(--bg)]" : "card"}`}
            >
              {m.content}
              {m.model && (
                <span className="muted mt-1 block text-xs" dir="ltr">
                  {m.model}
                  {m.costMicros ? ` · $${(m.costMicros / 1_000_000).toFixed(4)}` : ""}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
