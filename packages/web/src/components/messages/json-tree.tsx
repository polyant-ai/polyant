// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * JsonTree
 *
 * A JSON value laid out as a tree whose objects and arrays open and close with
 * a click on their key or its +/− toggle. Only the first level is shown open: a
 * turn's payload is several screens tall, and the reader goes looking for one
 * branch of it. A leaf value copies itself to the clipboard on click.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

type Composite = Record<string, unknown> | unknown[];

function isComposite(value: unknown): value is Composite {
  return value !== null && typeof value === "object";
}

function entriesOf(value: Composite): Array<[string, unknown]> {
  return Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value);
}

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span className="whitespace-pre-wrap break-words text-foreground">&quot;{value}&quot;</span>;
  }
  if (value === undefined) return <span className="text-muted-foreground">undefined</span>;
  return <span className="text-primary">{JSON.stringify(value)}</span>;
}

/** A leaf value that copies itself on click: a string as its bare text, anything else as JSON. */
function CopyableValue({ name, value }: { name: string; value: unknown }) {
  const { t } = useI18n();
  const { copy, copied } = useCopyToClipboard(1500);
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "undefined";
  const label = copied ? t("common.copied") : t("common.copy");
  return (
    <button
      type="button"
      title={label}
      aria-label={`${label} ${name}`}
      onClick={() => void copy(text)}
      className="group/value -mx-1 inline-flex min-w-0 items-start gap-1.5 rounded-sm px-1 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Scalar value={value} />
      {copied ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
      ) : (
        <Copy className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/value:opacity-100 group-focus-visible/value:opacity-100" />
      )}
    </button>
  );
}

/** An empty object or array, written as its literal. */
function Empty({ value }: { value: Composite }) {
  return <span className="text-muted-foreground">{Array.isArray(value) ? "[]" : "{}"}</span>;
}

function Node({ name, value }: { name: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  const composite = isComposite(value);
  const empty = composite && entriesOf(value).length === 0;
  const keyClass = "shrink-0 font-semibold text-foreground";

  return (
    <li>
      {composite && !empty ? (
        // The key opens the branch as much as the toggle does: one button spans both.
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 flex items-start gap-1 rounded-sm px-1 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border bg-background text-xs leading-none text-muted-foreground"
          >
            {open ? "−" : "+"}
          </span>
          <span className={keyClass}>{name}</span>
        </button>
      ) : (
        <div className="flex items-start gap-1">
          <span className="size-4 shrink-0" />
          <span className={keyClass}>{name}:</span>
          <span className="min-w-0">{empty ? <Empty value={value} /> : <CopyableValue name={name} value={value} />}</span>
        </div>
      )}
      {composite && open && <Entries value={value} nested />}
    </li>
  );
}

function Entries({ value, nested = false }: { value: Composite; nested?: boolean }) {
  return (
    <ul className={cn("flex flex-col gap-0.5", nested && "ml-2 mt-0.5 border-l pl-3")}>
      {entriesOf(value).map(([key, item]) => (
        <Node key={key} name={key} value={item} />
      ))}
    </ul>
  );
}

export function JsonTree({ value, className }: { value: unknown; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-[13px] leading-relaxed", className)}>
      {isComposite(value) && entriesOf(value).length > 0 ? (
        <Entries value={value} />
      ) : isComposite(value) ? (
        <Empty value={value} />
      ) : (
        <Scalar value={value} />
      )}
    </div>
  );
}
