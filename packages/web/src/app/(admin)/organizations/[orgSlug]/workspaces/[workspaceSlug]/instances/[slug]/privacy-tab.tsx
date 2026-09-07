// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, getUserErrorMessage, type Instance, type OptoutContact } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { formatDate } from "@/lib/format";
import { usePageSaveAction } from "./page-actions-context";

interface Props {
  instance: Instance;
  onSaved?: () => void;
}

// Channels whose inbound gate + outbound suppression actually honor opt-out
// (agent/web/scheduled/room are excluded server-side). Kept separate from the
// Room outbound list: same values today, distinct concepts that may diverge.
const OPTOUT_CHANNELS = ["whatsapp", "telegram", "slack"] as const;

// Example contact id per channel, to hint the admin what to type.
const CHANNEL_ID_PLACEHOLDER: Record<string, string> = {
  whatsapp: "+39123456789",
  telegram: "chat id",
  slack: "Uxxxx / Dxxxx",
};

function parseKeywords(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function sameKeywords(input: string, base: string[]): boolean {
  const parsed = parseKeywords(input);
  return parsed.length === base.length && parsed.every((k, i) => k === base[i]);
}

export function PrivacyTab({ instance, onSaved }: Props) {
  const { t } = useI18n();

  // ── Config form state ──────────────────────────────────────────────
  const [enabled, setEnabled] = useState(instance.optoutEnabled);
  const [stopKeywords, setStopKeywords] = useState(
    instance.optoutStopKeywords.join(", "),
  );
  const [resumeKeywords, setResumeKeywords] = useState(
    instance.optoutResumeKeywords.join(", "),
  );
  const [closingMsg, setClosingMsg] = useState(instance.optoutClosingMessage ?? "");
  const [resumeMsg, setResumeMsg] = useState(instance.optoutResumeMessage ?? "");
  const [injectHint, setInjectHint] = useState(instance.optoutInjectPromptHint);
  const [saving, setSaving] = useState(false);

  // ── Contacts table state ───────────────────────────────────────────
  const [contacts, setContacts] = useState<OptoutContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(true);

  // ── Opt-out-a-contact form state ───────────────────────────────────
  const [newChannelType, setNewChannelType] = useState<string>(OPTOUT_CHANNELS[0]);
  const [newChannelId, setNewChannelId] = useState("");
  const [addingContact, setAddingContact] = useState(false);

  const refreshContacts = async () => {
    setLoadingContacts(true);
    try {
      const res = await api.optouts.list(instance.slug, { status: "opted_out" });
      setContacts(res.optouts);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("privacy.loadContactsFailed")));
    } finally {
      setLoadingContacts(false);
    }
  };

  useEffect(() => {
    void refreshContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.slug]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.instances.update(instance.slug, {
        optoutEnabled: enabled,
        optoutStopKeywords: parseKeywords(stopKeywords),
        optoutResumeKeywords: parseKeywords(resumeKeywords),
        optoutClosingMessage: closingMsg.trim() || null,
        optoutResumeMessage: resumeMsg.trim() || null,
        optoutInjectPromptHint: injectHint,
      });
      onSaved?.();
      toast.success(t("privacy.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("privacy.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const isDirty =
    enabled !== instance.optoutEnabled ||
    !sameKeywords(stopKeywords, instance.optoutStopKeywords) ||
    !sameKeywords(resumeKeywords, instance.optoutResumeKeywords) ||
    closingMsg.trim() !== (instance.optoutClosingMessage ?? "") ||
    resumeMsg.trim() !== (instance.optoutResumeMessage ?? "") ||
    injectHint !== instance.optoutInjectPromptHint;

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  const handleReEnable = async (contact: OptoutContact) => {
    try {
      await api.optouts.optIn(instance.slug, contact.channelType, contact.channelId);
      toast.success(t("privacy.reEnableSuccess"));
      await refreshContacts();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("privacy.reEnableFailed")));
    }
  };

  const handleOptOutContact = async () => {
    const channelType = newChannelType.trim();
    const channelId = newChannelId.trim();
    if (!channelType || !channelId) return;
    setAddingContact(true);
    try {
      await api.optouts.optOut(instance.slug, channelType, channelId);
      toast.success(t("privacy.optOutContactSuccess"));
      setNewChannelType(OPTOUT_CHANNELS[0]);
      setNewChannelId("");
      await refreshContacts();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("privacy.optOutContactFailed")));
    } finally {
      setAddingContact(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-8">
      {/* ── GDPR opt-out config ──────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("privacy.title")}</Label>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("privacy.description")}
          </p>
        </div>

        {/* Enable toggle */}
        <div className="flex items-center justify-between border-t pt-4">
          <Label>{t("privacy.enable")}</Label>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {enabled && (
          <>
            {/* Stop keywords */}
            <div className="space-y-2">
              <Label htmlFor="stop-keywords">{t("privacy.stopKeywords")}</Label>
              <Input
                id="stop-keywords"
                value={stopKeywords}
                onChange={(e) => setStopKeywords(e.target.value)}
                placeholder="STOP, UNSUBSCRIBE"
              />
              <p className="text-xs text-muted-foreground">
                {t("privacy.keywordsHint")}
              </p>
            </div>

            {/* Resume keywords */}
            <div className="space-y-2">
              <Label htmlFor="resume-keywords">{t("privacy.resumeKeywords")}</Label>
              <Input
                id="resume-keywords"
                value={resumeKeywords}
                onChange={(e) => setResumeKeywords(e.target.value)}
                placeholder="START, SUBSCRIBE"
              />
            </div>

            {/* Closing message */}
            <div className="space-y-2">
              <Label htmlFor="closing-msg">{t("privacy.closingMessage")}</Label>
              <Textarea
                id="closing-msg"
                value={closingMsg}
                onChange={(e) => setClosingMsg(e.target.value)}
                placeholder={t("privacy.closingMessagePlaceholder")}
                rows={3}
              />
            </div>

            {/* Resume message */}
            <div className="space-y-2">
              <Label htmlFor="resume-msg">{t("privacy.resumeMessage")}</Label>
              <Textarea
                id="resume-msg"
                value={resumeMsg}
                onChange={(e) => setResumeMsg(e.target.value)}
                placeholder={t("privacy.resumeMessagePlaceholder")}
                rows={3}
              />
            </div>

            {/* Inject prompt hint toggle */}
            <div className="flex items-center justify-between border-t pt-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">
                  {t("privacy.injectHint")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("privacy.injectHintHelp")}
                </p>
              </div>
              <Switch checked={injectHint} onCheckedChange={setInjectHint} />
            </div>
          </>
        )}
      </section>

      {/* ── Opted-out contacts ───────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("privacy.contactsTitle")}</Label>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("privacy.contactsDescription")}
          </p>
        </div>

        {loadingContacts ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : contacts.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("privacy.contactsEmpty")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("privacy.channel")}</TableHead>
                <TableHead>{t("privacy.contact")}</TableHead>
                <TableHead>{t("privacy.date")}</TableHead>
                <TableHead>{t("privacy.source")}</TableHead>
                <TableHead className="w-[110px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((c) => (
                <TableRow key={`${c.channelType}:${c.channelId}`}>
                  <TableCell className="font-medium">{c.channelType}</TableCell>
                  <TableCell className="font-mono text-xs">{c.channelId}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.updatedAt ? formatDate(c.updatedAt) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.source}</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReEnable(c)}
                    >
                      {t("privacy.reEnable")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* ── Manual opt-out form ──────────────────────────────────── */}
        <div className="border-t pt-4">
          <Label className="text-sm font-medium">{t("privacy.optOutContact")}</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("privacy.optOutContactHelp")}
          </p>
          <div className="mt-3 flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("privacy.channel")}</Label>
              <Select value={newChannelType} onValueChange={setNewChannelType}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPTOUT_CHANNELS.map((ch) => (
                    <SelectItem key={ch} value={ch}>
                      {ch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 space-y-1">
              <Label className="text-xs">{t("privacy.contact")}</Label>
              <Input
                value={newChannelId}
                onChange={(e) => setNewChannelId(e.target.value)}
                placeholder={CHANNEL_ID_PLACEHOLDER[newChannelType] ?? ""}
              />
            </div>
            <Button
              size="default"
              disabled={addingContact || !newChannelType.trim() || !newChannelId.trim()}
              onClick={handleOptOutContact}
            >
              {addingContact ? t("common.saving") : t("privacy.optOutContactButton")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
