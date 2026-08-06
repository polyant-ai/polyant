// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Trash2, Download } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, getUserErrorMessage, type Instance, type ToolState, type SkillState, type PromptSection } from "@/lib/api";
import { GeneralTab } from "./general-tab";
import { PromptsTab } from "./prompts-tab";
import { ToolsTab } from "./tools-tab";
import { SkillsTab } from "./skills-tab";
import { SettingsTab } from "./settings-tab";
import { KnowledgeTab } from "./knowledge-tab";
import { ChannelsTab } from "./channels-tab";
import { McpServersTab } from "./mcp-servers-tab";
import { AnalyticsTab } from "./analytics-tab";
import { TriggersWebhooksTab } from "./triggers-webhooks-tab";
import { TriggersScheduledTab } from "./triggers-scheduled-tab";
import { TriggersRunsTab } from "./triggers-runs-tab";
import { RoomTab } from "./room-tab";
import { HooksTab } from "./hooks-tab";
import { PrivacyTab } from "./privacy-tab";
import { PageActionsProvider, usePageActions } from "./page-actions-context";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  agentSectionsByMacro,
  macroOfTab,
  resolveAgentTab,
} from "@/lib/nav/agent-sections";
import { useI18n } from "@/lib/i18n/context";
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const paths = useTenantPaths();

  // ONE resolver, shared with the sidebar: aliases applied, unknown values landing
  // on the default. Two copies is how the lit entry and the open page diverge.
  const activeTab = resolveAgentTab(searchParams.get("tab"));

  const siblings = agentSectionsByMacro(macroOfTab(activeTab));

  const handleTabChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", value);
    // push (not replace) so browser back/forward navigates between visited tabs
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const [instance, setInstance] = useState<Instance | null>(null);
  const [tools, setTools] = useState<ToolState[]>([]);
  const [skills, setSkills] = useState<SkillState[]>([]);
  const [prompts, setPrompts] = useState<PromptSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

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
  }, [params.slug, router, t]);

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
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={paths.workspace("/instances")}>{t("instances.detail.breadcrumb")}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{instance.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="mt-4 flex items-start justify-between">
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
        <div className="flex items-center gap-2">
          <HeaderSaveButton />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExport}
            disabled={exporting}
            className="gap-1.5"
          >
            <Download className="h-4 w-4" />
            {exporting ? t("exportImport.export.downloading") : t("exportImport.export.button")}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-destructive">
                <Trash2 className="h-4 w-4" />
                {t("instances.detail.deleteButton")}
              </Button>
            </AlertDialogTrigger>
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

      {/* The tab row holds the sections of the ONE sidebar entry that is lit — never
          all of them. A macro with a single section renders no row at all: a tab bar
          with one tab is chrome that says nothing. */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="mt-8">
        {siblings.length > 1 && (
          <TabsList>
            {siblings.map((section) => (
              <TabsTrigger key={section.tab} value={section.tab}>
                {t(section.titleKey)}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        <div className="mt-6">

          {activeTab === "general" && (
            <GeneralTab instance={instance} onUpdate={setInstance} />
          )}
          {activeTab === "prompts" && (
            <PromptsTab slug={instance.slug} prompts={prompts} onUpdate={setPrompts} />
          )}
          {activeTab === "tools" && (
            <ToolsTab
              slug={instance.slug}
              tools={tools}
              skills={skills}
              memoryEnabled={instance.memoryEnabled}
              knowledgeEnabled={instance.knowledgeEnabled}
              onToolsUpdate={setTools}
              onSkillsUpdate={setSkills}
            />
          )}
          {activeTab === "mcp" && <McpServersTab slug={instance.slug} />}
          {activeTab === "skills" && (
            <SkillsTab
              slug={instance.slug}
              skills={skills}
              tools={tools}
              onSkillsUpdate={setSkills}
              onToolsUpdate={setTools}
            />
          )}
          {activeTab === "knowledge" && (
            <KnowledgeTab slug={instance.slug} instance={instance} onUpdate={setInstance} />
          )}
          {activeTab === "settings" && (
            <SettingsTab instance={instance} onUpdate={setInstance} />
          )}
          {activeTab === "channels" && <ChannelsTab slug={instance.slug} />}
          {activeTab === "analytics" && <AnalyticsTab slug={instance.slug} />}
          {activeTab === "webhooks" && <TriggersWebhooksTab slug={instance.slug} />}
          {activeTab === "scheduled" && <TriggersScheduledTab slug={instance.slug} />}
          {activeTab === "runs" && <TriggersRunsTab slug={instance.slug} />}
          {activeTab === "room" && <RoomTab slug={instance.slug} />}
          {activeTab === "hooks" && <HooksTab slug={instance.slug} />}
          {activeTab === "privacy" && (
            <PrivacyTab
              instance={instance}
              onSaved={() => {
                api.instances.get(params.slug).then((r) => setInstance(r.instance)).catch(() => {});
              }}
            />
          )}
        </div>
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
