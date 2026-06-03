// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

// Allow highlight.js class names on code/span elements
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
  },
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="absolute right-2 top-2 rounded-sm bg-secondary p-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      aria-label="Copy code"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn("prose-sm max-w-none", className)}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
      components={{
        pre({ children, ...props }) {
          // Extract text content for copy button
          const codeElement = Array.isArray(children)
            ? children.find(
                (child) =>
                  typeof child === "object" &&
                  child !== null &&
                  "type" in child &&
                  child.type === "code",
              )
            : typeof children === "object" &&
                children !== null &&
                "type" in children &&
                children.type === "code"
              ? children
              : null;

          const codeText =
            codeElement &&
            typeof codeElement === "object" &&
            "props" in codeElement
              ? String(
                  (codeElement as { props: { children?: unknown } }).props
                    .children ?? "",
                )
              : "";

          return (
            <div className="group relative">
              <pre
                className="overflow-x-auto whitespace-pre-wrap break-words rounded-sm bg-muted p-4 text-xs"
                {...props}
              >
                {children}
              </pre>
              {codeText && <CopyButton text={codeText} />}
            </div>
          );
        },
        code({ className: codeClassName, children, ...props }) {
          const isInline = !codeClassName;
          if (isInline) {
            return (
              <code
                className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <code className={codeClassName} {...props}>
              {children}
            </code>
          );
        },
        a({ href, children, ...props }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-strong underline underline-offset-4 hover:text-accent-strong/80"
              {...props}
            >
              {children}
            </a>
          );
        },
        table({ children, ...props }) {
          return (
            <div className="overflow-x-auto">
              <table
                className="w-full border-collapse text-sm"
                {...props}
              >
                {children}
              </table>
            </div>
          );
        },
        th({ children, ...props }) {
          return (
            <th
              className="border border-border bg-muted px-3 py-2 text-left text-xs font-semibold"
              {...props}
            >
              {children}
            </th>
          );
        },
        td({ children, ...props }) {
          return (
            <td className="border border-border px-3 py-2 text-xs" {...props}>
              {children}
            </td>
          );
        },
        ul({ children, ...props }) {
          return (
            <ul className="list-disc space-y-1 pl-4" {...props}>
              {children}
            </ul>
          );
        },
        ol({ children, ...props }) {
          return (
            <ol className="list-decimal space-y-1 pl-4" {...props}>
              {children}
            </ol>
          );
        },
        p({ children, ...props }) {
          return (
            <p className="leading-relaxed [&:not(:first-child)]:mt-3" {...props}>
              {children}
            </p>
          );
        },
        blockquote({ children, ...props }) {
          return (
            <blockquote
              className="border-l-2 border-border pl-4 text-muted-foreground italic"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
}
