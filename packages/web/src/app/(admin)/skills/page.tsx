// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { api, getUserErrorMessage, type LibrarySkillSummary } from "@/lib/api";
import { LoadFailed } from "@/components/ui/load-failed";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/layout/page-header";
import { useI18n } from "@/lib/i18n/context";

const NO_SKILLS: LibrarySkillSummary[] = [];

export default function SkillsPage() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useResource("skill-library", () => api.skillLibrary.list());
  const skills: LibrarySkillSummary[] = Array.isArray(data?.skills) ? data.skills : NO_SKILLS;

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

  const handleDelete = async (name: string) => {
    try {
      await api.skillLibrary.delete(name);
      reload();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.deleteFailed")));
    }
  };

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
                size="sm"
                onClick={() => importSkillsRef.current?.click()}
                disabled={importingSkills}
                className="gap-2"
              >
                <Upload className="h-4 w-4" />
                {importingSkills ? t("exportImport.import.uploading") : t("exportImport.skills.import.button")}
              </Button>
              <input
                ref={importSkillsRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleImportSkills}
              />
              <Button asChild>
                <Link href="/skills/new">
                  <Plus className="mr-2 size-4" />
                  {t("skills.newSkill")}
                </Link>
              </Button>
            </>
          )
        }
      />

      {error && data === undefined ? (
        <LoadFailed message={t("skills.fetchFailed")} onRetry={reload} />
      ) : loading && data === undefined ? (
        <p className="mt-2 text-muted-foreground">{t("common.loading")}</p>
      ) : skills.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center">
          <p className="text-muted-foreground">{t("skills.empty")}</p>
          <Button asChild className="mt-4" variant="outline">
            <Link href="/skills/new">{t("skills.empty.cta")}</Link>
          </Button>
        </div>
      ) : (
        <div className="mt-6 [&_[data-slot=table-container]]:overflow-hidden">
          <Table className="table-fixed w-full">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">{t("skills.table.name")}</TableHead>
                <TableHead className="w-[100px]">{t("skills.table.category")}</TableHead>
                <TableHead>{t("skills.table.description")}</TableHead>
                <TableHead className="w-[100px]">
                  {t("skills.table.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {skills.map((skill) => (
                <TableRow key={skill.name}>
                  <TableCell className="font-medium truncate">
                    <Link
                      href={`/skills/${skill.name}`}
                      className="underline underline-offset-4 hover:text-accent-strong"
                    >
                      {skill.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {skill.category ? (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {skill.category}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-0 truncate whitespace-normal">
                    <span className="line-clamp-1">{skill.description}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" asChild>
                        <Link href={`/skills/${skill.name}`}>
                          <Pencil className="size-4" />
                        </Link>
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <Trash2 className="size-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {t("skills.deleteTitle")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("skills.deleteDescription", { name: skill.name })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(skill.name)}>
                              {t("common.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
