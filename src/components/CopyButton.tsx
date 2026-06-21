"use client";

import { useEffect, useRef, useState } from "react";

/** Copy `text` to the clipboard, with a textarea fallback for non-secure contexts. */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

/** Small "Copy" button that flips to a confirmation for ~1.5s after a successful copy. */
export default function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function onCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await copyText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
      setCopied(false);
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1500);
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={!text}
      title="Copy to clipboard"
      className={`rounded-lg bg-black/10 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-black/20 disabled:opacity-50 dark:bg-white/10 dark:text-zinc-200 ${className}`}
    >
      {copied ? "Copied ✓" : failed ? "Copy failed" : `⧉ ${label}`}
    </button>
  );
}
