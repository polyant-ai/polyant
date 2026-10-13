// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** The chip look of the Prompts section: one place for every chip switcher. */
export const chipVariants = cva("flex shrink-0 items-center rounded-md border text-sm transition-colors", {
  variants: {
    active: {
      true: "border-foreground bg-primary text-primary-foreground",
      false: "text-muted-foreground hover:bg-secondary hover:text-foreground",
    },
    size: {
      sm: "gap-1.5 px-2.5 py-1.5",
      md: "gap-2 px-3 py-2",
    },
  },
  defaultVariants: { active: false, size: "sm" },
});

export interface ChipProps
  extends Omit<React.ComponentProps<"button">, "ref">,
    Omit<VariantProps<typeof chipVariants>, "active"> {
  active?: boolean;
}

export const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { active = false, size, className, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(chipVariants({ active, size }), className)} {...props} />;
});
