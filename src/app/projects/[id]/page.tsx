import Link from "next/link";
import { notFound } from "next/navigation";
import DeleteProjectButton from "@/components/DeleteProjectButton";
import PreflightPanel from "@/components/PreflightPanel";
import ProjectDashboard from "@/components/ProjectDashboard";
import type { PreflightReport } from "@/lib/preflight";
import {
  deriveResearchTopic,
  getPreflightReport,
  getProject,
  hasUnscannedActivity,
  listConversations,
  listItemsWithSource,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(Number(id));
  if (!project) notFound();

  const items = listItemsWithSource(project.id);
  const conversations = listConversations(project.id);
  const pendingIds = conversations.filter(hasUnscannedActivity).map((c) => c.id);
  const pfRow = getPreflightReport(project.id);
  const preflightInitial: PreflightReport | null = pfRow
    ? (JSON.parse(pfRow.report) as PreflightReport)
    : null;

  return (
    <div>
      <div className="mb-6">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          ← All projects
        </Link>
        <div className="mt-1 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <p className="text-xs text-zinc-400">{project.cwd}</p>
            <p className="mt-1 text-sm text-zinc-500">
              {conversations.length} conversation{conversations.length === 1 ? "" : "s"}
            </p>
          </div>
          <DeleteProjectButton
            projectId={project.id}
            projectName={project.name}
            className="mt-1 shrink-0"
          />
        </div>
      </div>

      <PreflightPanel
        projectId={project.id}
        initial={preflightInitial}
        initialFetchedAt={pfRow?.fetched_at ?? null}
      />

      <ProjectDashboard
        initialItems={items}
        projectId={project.id}
        conversationIds={conversations.map((c) => c.id)}
        pendingConversationIds={pendingIds}
        derivedTopic={deriveResearchTopic(project.id)}
      />
    </div>
  );
}
