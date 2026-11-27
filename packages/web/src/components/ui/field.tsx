// SPDX-License-Identifier: AGPL-3.0-or-later

"use client"

import * as React from "react"
import { Slot } from "radix-ui"

import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

type FieldContextValue = {
  id: string
  descriptionId: string
  errorId: string
  hasDescription: boolean
  hasError: boolean
  setHasDescription: (value: boolean) => void
  setHasError: (value: boolean) => void
}

const FieldContext = React.createContext<FieldContextValue | null>(null)

function useField(component: string): FieldContextValue {
  const context = React.useContext(FieldContext)
  if (!context) throw new Error(`${component} must be rendered inside <Field>`)
  return context
}

function Field({ id: idProp, ...props }: React.ComponentProps<"div">) {
  const generated = React.useId()
  const id = idProp ?? generated
  const [hasDescription, setHasDescription] = React.useState(false)
  const [hasError, setHasError] = React.useState(false)
  const value = React.useMemo<FieldContextValue>(
    () => ({
      id,
      descriptionId: `${id}-description`,
      errorId: `${id}-error`,
      hasDescription,
      hasError,
      setHasDescription,
      setHasError,
    }),
    [id, hasDescription, hasError],
  )
  return (
    <FieldContext.Provider value={value}>
      <div data-slot="field" {...props} />
    </FieldContext.Provider>
  )
}

function FieldLabel(props: React.ComponentProps<typeof Label>) {
  const { id } = useField("FieldLabel")
  return <Label htmlFor={id} {...props} />
}

function FieldControl({
  "aria-describedby": describedByProp,
  ...props
}: React.ComponentProps<typeof Slot.Root>) {
  const { id, descriptionId, errorId, hasDescription, hasError } = useField("FieldControl")
  const describedBy =
    [describedByProp, hasDescription ? descriptionId : null, hasError ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined
  return (
    <Slot.Root
      id={id}
      aria-describedby={describedBy}
      aria-invalid={hasError ? true : undefined}
      {...props}
    />
  )
}

function isEmpty(children: React.ReactNode): boolean {
  return children === null || children === undefined || children === false || children === ""
}

function useRegistration(present: boolean, set: (value: boolean) => void) {
  React.useLayoutEffect(() => {
    if (!present) return
    set(true)
    return () => set(false)
  }, [present, set])
}

function FieldDescription({ className, children, ...props }: React.ComponentProps<"p">) {
  const { descriptionId, setHasDescription } = useField("FieldDescription")
  const present = !isEmpty(children)
  useRegistration(present, setHasDescription)
  if (!present) return null
  return (
    <p
      id={descriptionId}
      data-slot="field-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    >
      {children}
    </p>
  )
}

function FieldError({ className, children, ...props }: React.ComponentProps<"p">) {
  const { errorId, setHasError } = useField("FieldError")
  const present = !isEmpty(children)
  useRegistration(present, setHasError)
  if (!present) return null
  return (
    <p
      id={errorId}
      role="alert"
      data-slot="field-error"
      className={cn("text-xs text-destructive", className)}
      {...props}
    >
      {children}
    </p>
  )
}

export { Field, FieldLabel, FieldControl, FieldDescription, FieldError }
