import Link from "next/link";
import { notFound } from "next/navigation";
import DeleteProjectButton from "@/components/DeleteProjectButton";
import ProjectDashboard from "@/components/ProjectDashboard";
import {
  deriveResearchTopic,
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
