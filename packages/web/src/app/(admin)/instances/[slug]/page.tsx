// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { AnalyticsTab } from "./analytics-tab";
import { TriggersTab } from "./triggers-tab";
import { RoomTab } from "./room-tab";
import { HooksTab } from "./hooks-tab";
import { PrivacyTab } from "./privacy-tab";
import { PageActionsProvider, usePageActions } from "./page-actions-context";
import { useI18n } from "@/lib/i18n/context";

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

export default function InstanceDetailPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const { t } = useI18n();
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
        router.push("/instances");
      })
      .finally(() => setLoading(false));
  }, [params.slug]);

  const handleDelete = async () => {
    try {
      await api.instances.delete(params.slug);
      toast.success(t("instances.detail.deleted"));
      router.push("/instances");
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
              <Link href="/instances">{t("instances.detail.breadcrumb")}</Link>
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

      <Tabs defaultValue="general" className="mt-8">
        <TabsList>
          <TabsTrigger value="general">{t("instances.detail.tabGeneral")}</TabsTrigger>
          <TabsTrigger value="prompts">{t("instances.detail.tabPrompts")}</TabsTrigger>
          <TabsTrigger value="tools">{t("instances.detail.tabTools")}</TabsTrigger>
          <TabsTrigger value="skills">{t("instances.detail.tabSkills")}</TabsTrigger>
          <TabsTrigger value="knowledge">{t("instances.detail.tabKnowledge")}</TabsTrigger>
          <TabsTrigger value="settings">{t("instances.detail.tabSettings")}</TabsTrigger>
          <TabsTrigger value="channels">{t("instances.detail.tabChannels")}</TabsTrigger>
          <TabsTrigger value="analytics">{t("instances.detail.tabAnalytics")}</TabsTrigger>
          <TabsTrigger value="triggers">{t("instances.detail.tabTriggers")}</TabsTrigger>
          <TabsTrigger value="room">{t("instances.detail.tabRoom")}</TabsTrigger>
          <TabsTrigger value="hooks">{t("instances.detail.tabHooks")}</TabsTrigger>
          <TabsTrigger value="privacy">{t("instances.detail.tabPrivacy")}</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="mt-6">
          <GeneralTab instance={instance} onUpdate={setInstance} />
        </TabsContent>
        <TabsContent value="prompts" className="mt-6">
          <PromptsTab slug={instance.slug} prompts={prompts} onUpdate={setPrompts} />
        </TabsContent>
        <TabsContent value="tools" className="mt-6">
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
        <TabsContent value="skills" className="mt-6">
          <SkillsTab
            slug={instance.slug}
            skills={skills}
            tools={tools}
            onSkillsUpdate={setSkills}
            onToolsUpdate={setTools}
          />
        </TabsContent>
        <TabsContent value="knowledge" className="mt-6">
          <KnowledgeTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="settings" className="mt-6">
          <SettingsTab instance={instance} onUpdate={setInstance} />
        </TabsContent>
        <TabsContent value="channels" className="mt-6">
          <ChannelsTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="analytics" className="mt-6">
          <AnalyticsTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="triggers" className="mt-6">
          <TriggersTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="room" className="mt-6">
          <RoomTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="hooks" className="mt-6">
          <HooksTab slug={instance.slug} />
        </TabsContent>
        <TabsContent value="privacy" className="mt-6">
          <PrivacyTab instance={instance} onSaved={() => setInstance((prev) => prev)} />
        </TabsContent>
      </Tabs>
    </div>
    </PageActionsProvider>
  );
}
