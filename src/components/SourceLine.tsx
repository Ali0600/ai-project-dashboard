import { formatDate } from "@/lib/format";
import type { ItemWithSource } from "@/lib/types";

/** Compact "From <conversation> · <date>" line shown on cards and list rows. */
export default function SourceLine({ item }: { item: ItemWithSource }) {
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
