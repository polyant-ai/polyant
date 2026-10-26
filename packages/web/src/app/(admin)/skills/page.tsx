// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { api, getUserErrorMessage, type LibrarySkillSummary } from "@/lib/api";
import { LoadFailed } from "@/components/ui/load-failed";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/layout/page-header";
import { ListHead, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { useListView } from "@/components/use-list-view";
import { ListEmpty, ListLoading, ListNoResults } from "@/components/list-states";
import { SkillSheet } from "@/components/skills/skill-sheet";
import { useI18n } from "@/lib/i18n/context";

const NO_SKILLS: LibrarySkillSummary[] = [];

function SkillsPageContent() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, error, loading, reload } = useResource("skill-library", () => api.skillLibrary.list());
  const skills: LibrarySkillSummary[] = Array.isArray(data?.skills) ? data.skills : NO_SKILLS;

  const [search, setSearch] = useState("");
  // `?skill=<slug>` opens that skill's drawer: it is how an old `/skills/<slug>` link still lands on the skill.
  const linked = searchParams.get("skill");
  const [openName, setOpenName] = useState<string | null>(linked);
  const closeDrawer = () => {
    setOpenName(null);
    if (linked) router.replace("/skills");
  };

  const [importingSkills, setImportingSkills] = useState(false);
  const importSkillsRef = useRef<HTMLInputElement>(null);

  const handleImportSkills = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportingSkills(true);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const result = await api.exportImport.importSkills(bundle);
      toast.success(
        t("exportImport.skills.import.success")
          .replace("{created}", String(result.created.length))
          .replace("{updated}", String(result.updated.length))
          .replace("{skipped}", String(result.skipped.length)),
      );
      reload();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("exportImport.skills.import.failed")));
    } finally {
      setImportingSkills(false);
      if (importSkillsRef.current) importSkillsRef.current.value = "";
    }
  };

  const addButton = (
    <Button asChild>
      <Link href="/skills/new">
        <Plus className="size-4" />
        {t("skills.newSkill")}
      </Link>
    </Button>
  );

  const visible = useListView(
    skills,
    search,
    (skill) => [skill.displayName, skill.name, skill.description, skill.category],
    (skill) => skill.displayName,
  );

  return (
    <div>
      <PageHeader
        title={t("skills.title")}
        subtitle={t("skills.subtitle")}
        actions={
          data !== undefined && (
            <>
              <Button
                variant="outline"
                onClick={() => importSkillsRef.current?.click()}
                disabled={importingSkills}
              >
                <Upload className="size-4" />
                {importingSkills ? t("exportImport.import.uploading") : t("exportImport.skills.import.button")}
              </Button>
              <input
                ref={importSkillsRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleImportSkills}
              />
              {addButton}
            </>
          )
        }
      />

      {error && data === undefined ? (
        <LoadFailed message={t("skills.fetchFailed")} onRetry={reload} />
      ) : loading && data === undefined ? (
        <ListLoading />
      ) : skills.length === 0 ? (
        <ListEmpty
          title={t("skills.empty")}
          action={
            <Button asChild variant="outline">
              <Link href="/skills/new">{t("skills.empty.cta")}</Link>
            </Button>
          }
        />
      ) : (
        <>
          <ListToolbar value={search} onChange={setSearch} className="mt-6" />
          {visible.length === 0 ? (
            <ListNoResults />
          ) : (
            <ListTable>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <ListHead>{t("skills.table.name")}</ListHead>
                  <ListHead className="w-40">{t("skills.table.category")}</ListHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((skill) => (
                  <ListRow key={skill.name} onOpen={() => setOpenName(skill.name)} selected={openName === skill.name}>
                    <ListNameCell
                      name={skill.displayName}
                      onOpen={() => setOpenName(skill.name)}
                      summary={skill.description || undefined}
                    />
                    <TableCell>
                      {skill.category ? (
                        <Badge variant="secondary">{skill.category}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </ListRow>
                ))}
              </TableBody>
            </ListTable>
          )}
        </>
      )}

      <SkillSheet key={openName ?? "closed"} name={openName} onClose={closeDrawer} onChanged={reload} />
    </div>
  );
}

export default function SkillsPage() {
  return (
    <Suspense fallback={null}>
      <SkillsPageContent />
    </Suspense>
  );
}
