import Link from "next/link";
import { notFound } from "next/navigation";
import ProjectDashboard from "@/components/ProjectDashboard";
import ScanPending from "@/components/ScanPending";
import { getProject, listConversations, listItems } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(Number(id));
  if (!project) notFound();

  const items = listItems(project.id);
  const conversations = listConversations(project.id);
  const pendingIds = conversations
    .filter((c) => c.scan_status === "needs_scan")
    .map((c) => c.id);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ← All projects
          </Link>
          <h1 className="mt-1 text-2xl font-bold">{project.name}</h1>
          <p className="text-xs text-zinc-400">{project.cwd}</p>
          <p className="mt-1 text-sm text-zinc-500">
            {conversations.length} conversation{conversations.length === 1 ? "" : "s"}
            {pendingIds.length > 0 && ` · ${pendingIds.length} need scanning`}
          </p>
        </div>
        <ScanPending conversationIds={pendingIds} />
      </div>

      <ProjectDashboard items={items} />
    </div>
  );
}
