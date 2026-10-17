"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** A copyable snippet for the public agent docs. */
export function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <figure className="overflow-hidden rounded-tile border border-line bg-white">
      <figcaption className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <span className="text-label font-semibold text-ink-2">{label}</span>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="press flex items-center gap-1 text-label font-semibold text-cyan-ink"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre className="overflow-x-auto bg-page px-3 py-3 text-label leading-[18px] text-ink">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
