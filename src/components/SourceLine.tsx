import { formatDate } from "@/lib/format";
import type { ItemWithSource } from "@/lib/types";

/** Short hostname for a URL (no protocol/www), for compact source labels. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

/** Compact "From <conversation> · <date>" line shown on cards and list rows. */
export default function SourceLine({ item }: { item: ItemWithSource }) {
  // Web-research items link out to where the idea was requested.
  if (item.source_url) {
    return (
      <a
        href={item.source_url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="mt-1.5 inline-block truncate text-[11px] text-indigo-500 hover:underline dark:text-indigo-400"
        title={item.source_url}
      >
        🌐 {hostOf(item.source_url)}
      </a>
    );
  }
  if (!item.conversation_title) {
    return <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">Added via /sync-board</p>;
  }
  return (
    <p
      className="mt-1.5 truncate text-[11px] text-zinc-400 dark:text-zinc-500"
      title={item.conversation_title}
    >
      From {item.conversation_title}
      {item.conversation_at ? ` · ${formatDate(item.conversation_at)}` : ""}
    </p>
  );
}
