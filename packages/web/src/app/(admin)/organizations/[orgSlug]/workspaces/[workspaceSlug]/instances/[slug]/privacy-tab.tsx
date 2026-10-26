// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import { ListDrawer } from "@/components/list-drawer";
import { ListBadgeCell, ListHead, ListMetaCell, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { ListEmpty, ListLoading, ListNoResults } from "@/components/list-states";
import { useListView } from "@/components/use-list-view";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { api, getUserErrorMessage, type Instance, type OptoutContact } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { LoadFailed } from "@/components/ui/load-failed";
import { useResource } from "@/hooks/use-resource";
import { usePageSaveAction } from "./page-actions-context";
import { useDraft } from "./use-draft";

interface Props {
  instance: Instance;
  onUpdate?: (instance: Instance) => void;
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

export function PrivacyTab({ instance, onUpdate }: Props) {
  const { t } = useI18n();
  const fmt = useFormat();

  // ── Config form state ──────────────────────────────────────────────
  const { draft, set, isDirty } = useDraft({
    enabled: instance.optoutEnabled,
    stopKeywords: instance.optoutStopKeywords.join(", "),
    resumeKeywords: instance.optoutResumeKeywords.join(", "),
    closingMsg: instance.optoutClosingMessage ?? "",
    resumeMsg: instance.optoutResumeMessage ?? "",
    injectHint: instance.optoutInjectPromptHint,
  });
  const { enabled, stopKeywords, resumeKeywords, closingMsg, resumeMsg, injectHint } = draft;
  const [saving, setSaving] = useState(false);

  // ── Contacts table state ───────────────────────────────────────────
  const { data, error: contactsError, loading: loadingContacts, reload: refreshContacts } = useResource(
    ["optouts", instance.slug],
    () => api.optouts.list(instance.slug, { status: "opted_out" }),
  );
  const contacts: OptoutContact[] = data?.optouts ?? [];

  // ── Opt-out-a-contact form state ───────────────────────────────────
  const [newChannelType, setNewChannelType] = useState<string>(OPTOUT_CHANNELS[0]);
  const [newChannelId, setNewChannelId] = useState("");
  const [addingContact, setAddingContact] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [openContact, setOpenContact] = useState<OptoutContact | null>(null);
  const visibleContacts = useListView(contacts, search, (c) => [c.channelId, c.channelType, c.source], (c) => c.channelId);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { instance: updated } = await api.instances.update(instance.slug, {
        optoutEnabled: enabled,
        optoutStopKeywords: parseKeywords(stopKeywords),
        optoutResumeKeywords: parseKeywords(resumeKeywords),
        optoutClosingMessage: closingMsg.trim() || null,
        optoutResumeMessage: resumeMsg.trim() || null,
        optoutInjectPromptHint: injectHint,
      });
      onUpdate?.(updated);
      toast.success(t("privacy.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("privacy.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  const handleReEnable = async (contact: OptoutContact) => {
    try {
      await api.optouts.optIn(instance.slug, contact.channelType, contact.channelId);
      toast.success(t("privacy.reEnableSuccess"));
      setOpenContact(null);
      refreshContacts();
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
      setAddOpen(false);
      refreshContacts();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("privacy.optOutContactFailed")));
    } finally {
      setAddingContact(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* ── GDPR opt-out config ──────────────────────────────────────── */}
      <section className="max-w-2xl space-y-4 rounded-lg border p-4">
        {/* The section's own title (the agent page's) already says "GDPR opt-out". */}
        <p className="text-sm text-muted-foreground">{t("privacy.description")}</p>

        {/* Enable toggle */}
        <div className="flex items-center justify-between border-t pt-4">
          <Label>{t("privacy.enable")}</Label>
          <Switch checked={enabled} onCheckedChange={(v) => set("enabled", v)} />
        </div>

        {enabled && (
          <>
            {/* Stop keywords */}
            <div className="space-y-2">
              <Label htmlFor="stop-keywords">{t("privacy.stopKeywords")}</Label>
              <Input
                id="stop-keywords"
                value={stopKeywords}
                onChange={(e) => set("stopKeywords", e.target.value)}
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
                onChange={(e) => set("resumeKeywords", e.target.value)}
                placeholder="START, SUBSCRIBE"
              />
            </div>

            {/* Closing message */}
            <div className="space-y-2">
              <Label htmlFor="closing-msg">{t("privacy.closingMessage")}</Label>
              <Textarea
                id="closing-msg"
                value={closingMsg}
                onChange={(e) => set("closingMsg", e.target.value)}
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
                onChange={(e) => set("resumeMsg", e.target.value)}
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
              <Switch checked={injectHint} onCheckedChange={(v) => set("injectHint", v)} />
            </div>
          </>
        )}
      </section>

      {/* ── Opted-out contacts ───────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label className="text-base font-medium">{t("privacy.contactsTitle")}</Label>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("privacy.contactsDescription")}
            </p>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 size-4" />
            {t("privacy.add")}
          </Button>
        </div>

        {contactsError ? (
          <LoadFailed message={t("privacy.loadContactsFailed")} onRetry={refreshContacts} />
        ) : loadingContacts ? (
          <ListLoading className="mt-4" />
        ) : contacts.length === 0 ? (
          <ListEmpty className="mt-4" title={t("privacy.contactsEmpty")} />
        ) : (
          <div>
            <ListToolbar value={search} onChange={setSearch} />
            {visibleContacts.length === 0 ? (
              <ListNoResults />
            ) : (
              <ListTable>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <ListHead>{t("privacy.contact")}</ListHead>
                    <ListHead className="w-32">{t("privacy.channel")}</ListHead>
                    <ListHead className="w-36">{t("privacy.date")}</ListHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleContacts.map((c) => (
                    <ListRow
                      key={`${c.channelType}:${c.channelId}`}
                      onOpen={() => setOpenContact(c)}
                      selected={openContact?.channelType === c.channelType && openContact.channelId === c.channelId}
                    >
                      <ListNameCell name={c.channelId} onOpen={() => setOpenContact(c)} summary={c.source} />
                      <ListBadgeCell>{c.channelType}</ListBadgeCell>
                      <ListMetaCell>{c.updatedAt ? fmt.date(c.updatedAt) : "—"}</ListMetaCell>
                    </ListRow>
                  ))}
                </TableBody>
              </ListTable>
            )}
          </div>
        )}

        {/* A contact's details and the way back in. */}
        <ListDrawer
          open={openContact !== null}
          onOpenChange={(open) => !open && setOpenContact(null)}
          title={openContact?.channelId ?? ""}
          description={openContact ? `${openContact.channelType} · ${openContact.source}` : ""}
          actions={
            openContact && (
              <Button onClick={() => handleReEnable(openContact)}>{t("privacy.reEnable")}</Button>
            )
          }
        >
          {openContact && (
            <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
              <dt className="text-muted-foreground">{t("privacy.channel")}</dt>
              <dd>{openContact.channelType}</dd>
              <dt className="text-muted-foreground">{t("privacy.contact")}</dt>
              <dd className="font-mono text-xs">{openContact.channelId}</dd>
              <dt className="text-muted-foreground">{t("privacy.date")}</dt>
              <dd>{openContact.updatedAt ? fmt.date(openContact.updatedAt) : "—"}</dd>
              <dt className="text-muted-foreground">{t("privacy.source")}</dt>
              <dd>{openContact.source}</dd>
            </dl>
          )}
        </ListDrawer>

        {/* ── Manual opt-out ───────────────────────────────────────── */}
        <ListDrawer
          open={addOpen}
          onOpenChange={setAddOpen}
          title={t("privacy.optOutContact")}
          description={t("privacy.optOutContactHelp")}
          primary={
            <Button
              disabled={addingContact || !newChannelType.trim() || !newChannelId.trim()}
              onClick={handleOptOutContact}
            >
              {addingContact ? t("common.saving") : t("common.add")}
            </Button>
          }
        >
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>{t("privacy.channel")}</Label>
              <Select value={newChannelType} onValueChange={setNewChannelType}>
                <SelectTrigger>
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
            <div className="space-y-1">
              <Label htmlFor="optout-contact">{t("privacy.contact")}</Label>
              <Input
                id="optout-contact"
                value={newChannelId}
                onChange={(e) => setNewChannelId(e.target.value)}
                placeholder={CHANNEL_ID_PLACEHOLDER[newChannelType] ?? ""}
              />
            </div>
          </div>
        </ListDrawer>
      </section>
    </div>
  );
}
