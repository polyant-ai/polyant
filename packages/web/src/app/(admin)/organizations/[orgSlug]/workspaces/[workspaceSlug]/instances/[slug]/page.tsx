// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Download, MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, getUserErrorMessage, type Instance, type ToolState, type SkillState, type PromptSection } from "@/lib/api";
import { GeneralTab } from "./general-tab";
import { PromptsTab } from "./prompts-tab";
import { ToolsTab } from "./tools-tab";
import { McpServersTab } from "./mcp-servers-tab";
import { SkillsTab } from "./skills-tab";
import { SettingsTab } from "./settings-tab";
import { KnowledgeTab } from "./knowledge-tab";
import { ChannelsSection } from "./channels-section";
import { AnalyticsTab } from "./analytics-tab";
import { StatusTab } from "./status-tab";
import { TriggersWebhooksTab } from "./triggers-webhooks-tab";
import { TriggersScheduledTab } from "./triggers-scheduled-tab";
import { LogsTab } from "./logs-tab";
import { ParamsTab } from "./params-tab";
import { AgentConversationsTab } from "./agent-conversations-tab";
import { AgentMemoriesTab } from "./agent-memories-tab";
import { RoomTab } from "./room-tab";
import { HooksTab } from "./hooks-tab";
import { PrivacyTab } from "./privacy-tab";
import { PageActionsProvider, usePageActions } from "./page-actions-context";
import { useI18n } from "@/lib/i18n/context";
import { agentSection, resolveAgentTab } from "@/lib/nav/agent-sections";
import { useTenantPaths } from "@/lib/tenant/use-tenant-paths";

function HeaderSaveButton() {
  const { saveAction } = usePageActions();
  const { t } = useI18n();
  if (!saveAction) return null;
  return (
    <Button
      size="sm"
      onClick={() => saveAction.onSave()}
      disabled={!saveAction.isDirty || saveAction.saving}
    >
      {saveAction.saving ? t("common.saving") : t("common.save")}
    </Button>
  );
}

function InstanceDetailContent() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const paths = useTenantPaths();

  // ONE resolver for the address, shared with the sidebar (`lib/nav/agent-sections.ts`):
  // it falls back to the landing section, so the two can never disagree about which
  // section is open. This file used to carry its own literal list of accepted values
  // and the test a second one.
  const activeTab = resolveAgentTab(searchParams.get("tab"));
  const section = agentSection(activeTab);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [tools, setTools] = useState<ToolState[]>([]);
  const [skills, setSkills] = useState<SkillState[]>([]);
  const [prompts, setPrompts] = useState<PromptSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    const slug = params.slug;
    Promise.all([
      api.instances.get(slug),
      api.tools.list(slug),
      api.skills.list(slug),
      api.prompts.list(slug),
    ])
      .then(([instanceRes, toolsRes, skillsRes, promptsRes]) => {
        setInstance(instanceRes.instance);
        setTools(toolsRes.tools);
        setSkills(skillsRes.skills);
        setPrompts(promptsRes.prompts);
      })
      .catch(() => {
        toast.error(t("instances.detail.notFound"));
        router.push(paths.workspace("/instances"));
      })
      .finally(() => setLoading(false));
    // `paths` belongs here: it is read in the catch branch. It is safe as a
    // dependency because `useTenantPaths` memoizes on the two URL slugs, so the
    // identity is stable across renders and cannot re-trigger the fetch.
  }, [params.slug, router, t, paths]);

  const handleDelete = async () => {
    try {
      await api.instances.delete(params.slug);
      toast.success(t("instances.detail.deleted"));
      router.push(paths.workspace("/instances"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("instances.detail.deleteFailed")));
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await api.exportImport.exportInstance(params.slug);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `${params.slug}-export-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("exportImport.export.failed")));
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!instance) return null;

  return (
    <PageActionsProvider>
    <div>
      {/* No breadcrumb here any more: "Agenti › this agent" is exactly what the
          sidebar now says while you are inside this destination — its back link
          and the subject beneath it — and the organization/workspace above them
          is in the header's trail. Two breadcrumbs for one position is the same
          "both surfaces try to say where you are" problem the takeover fixed. */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {instance.name}
          </h1>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {instance.slug}
            </code>
            <Badge variant={instance.status === "active" ? "default" : "secondary"}>
              {instance.status}
            </Badge>
          </div>
        </div>
        {/*
          Save is the only action at full weight here. Export and Delete moved
          into a menu: they are agent-level and rare, they were being read as
          part of the section you happened to be in, and Delete — irreversible —
          sat in the most prominent corner of the page at the same weight as a
          download.
        */}
        <div className="flex items-center gap-2">
          <HeaderSaveButton />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("common.moreActions")}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleExport} disabled={exporting}>
                <Download className="h-4 w-4" />
                {exporting
                  ? t("exportImport.export.downloading")
                  : t("exportImport.export.agentButton")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={(event) => {
                  // The menu closes on select; opening the dialog from inside a
                  // closing menu loses the focus trap, so it is deferred to the
                  // page's own dialog state.
                  event.preventDefault();
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
                {t("instances.detail.deleteButton")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("instances.detail.deleteTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("instances.detail.deleteDescription", { name: instance.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  {t("common.delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/*
        The section NAMES itself. With the tab row gone, the only thing saying
        which section was open was the lit row in the sidebar 500px to the left —
        and half the sections opened with an unheaded paragraph, so the page
        began mid-sentence. One heading, from the same registry the sidebar reads,
        so the two cannot drift.
      */}
      <h2 className="mt-8 text-2xl font-semibold tracking-tight">{t(section.titleKey)}</h2>

      {/* `Tabs` stays purely as the panel switcher — `?tab=` picks which
          `TabsContent` renders, and nothing on this page changes it. */}
      <Tabs value={activeTab} className="mt-6">
        {/* Panoramica */}
        <TabsContent value="overview">
          <StatusTab instance={instance} tools={tools} skills={skills} />
        </TabsContent>
        <TabsContent value="analytics">
          <AnalyticsTab slug={instance.slug} />
        </TabsContent>

        {/* Configurazione */}
        <TabsContent value="general">
          <GeneralTab instance={instance} onUpdate={setInstance} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab instance={instance} onUpdate={setInstance} section="model" />
        </TabsContent>
        <TabsContent value="credentials">
          <p className="mb-6 text-sm text-muted-foreground">
            {t("instances.section.credentialsHelp")}
          </p>
          <SettingsTab instance={instance} onUpdate={setInstance} section="credentials" />
        </TabsContent>
        <TabsContent value="channels">
          <ChannelsSection instance={instance} onUpdate={setInstance} />
        </TabsContent>

        {/* Comportamento */}
        <TabsContent value="prompts">
          <PromptsTab slug={instance.slug} prompts={prompts} onUpdate={setPrompts} />
        </TabsContent>
        <TabsContent value="tools">
          <ToolsTab
            slug={instance.slug}
            tools={tools}
            skills={skills}
            memoryEnabled={instance.memoryEnabled}
            knowledgeEnabled={instance.knowledgeEnabled}
            onToolsUpdate={setTools}
            onSkillsUpdate={setSkills}
          />
        </TabsContent>
        <TabsContent value="toolSecrets">
          <SettingsTab instance={instance} onUpdate={setInstance} section="toolSecrets" />
        </TabsContent>
        {/* MCP servers: their own section, no longer the tail of the Tools page.
            `mcp-servers.controller.ts` gates it on the CHANNEL permission — an MCP
            server is a connection this agent holds credentials for — so it fails on
            its own terms rather than borrowing another page's. */}
        <TabsContent value="mcp">
          <McpServersTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="skills">
          <SkillsTab
            slug={instance.slug}
            skills={skills}
            tools={tools}
            onSkillsUpdate={setSkills}
            onToolsUpdate={setTools}
          />
        </TabsContent>
        <TabsContent value="knowledge">
          <KnowledgeTab slug={instance.slug} instance={instance} onUpdate={setInstance} />
        </TabsContent>
        <TabsContent value="hooks">
          <HooksTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="params">
          <ParamsTab instance={instance} onUpdate={setInstance} />
        </TabsContent>

        {/* Automazioni */}
        <TabsContent value="webhooks">
          <TriggersWebhooksTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="scheduled">
          <TriggersScheduledTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="room">
          <RoomTab slug={instance.slug} />
        </TabsContent>

        {/* Governance — the gates, the compliance artifacts and the retention
            policy are Enterprise; what ships here is the opt-out. */}
        <TabsContent value="privacy">
          <PrivacyTab
            instance={instance}
            onSaved={() => {
              api.instances
                .get(params.slug)
                .then((r) => setInstance(r.instance))
                .catch(() => {});
            }}
          />
        </TabsContent>

        {/* Attività — what this agent has done, not how it is configured. */}
        <TabsContent value="conversations">
          <AgentConversationsTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="memories">
          <AgentMemoriesTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="logs">
          <LogsTab slug={instance.slug} />
        </TabsContent>
      </Tabs>
    </div>
    </PageActionsProvider>
  );
}

export default function InstanceDetailPage() {
  return (
    <Suspense fallback={null}>
      <InstanceDetailContent />
    </Suspense>
  );
}
