"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";

/** Read-only code/link box with a copy button. Always left-to-right (code and URLs). */
export function CopyField({
  value,
  multiline = false,
  label,
}: {
  value: string;
  multiline?: boolean;
  label: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the text is still selectable.
    }
  }

  return (
    <div className="flex items-start gap-2">
      {multiline ? (
        <textarea
          className="input font-mono text-xs"
          dir="ltr"
          readOnly
          rows={3}
          value={value}
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : (
        <input
          className="input font-mono text-xs"
          dir="ltr"
          readOnly
          value={value}
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      <button type="button" className="btn btn-ghost shrink-0" onClick={copy}>
        {copied ? t("share.copied") : t("share.copy")}
      </button>
    </div>
  );
}
