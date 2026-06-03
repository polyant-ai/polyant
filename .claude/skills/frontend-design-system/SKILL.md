---
name: frontend-design-system
description: Use when building, modifying, or adding any UI component, page, or style in packages/web. Use when choosing colors, spacing, typography, component patterns, or layout structure. Use when adding new shadcn/ui components or creating custom components.
---

# Frontend Design System

## Overview

Design system: minimal, flat, white-dominant (light) / dark-dominant (dark), black primary, accent-only color. Built on Next.js 15, React 19, Tailwind CSS 4, shadcn/ui (new-york style).

**Core principle:** Clarity over decoration. Black and white with generous whitespace. Color is semantic, never decorative.

## Design Philosophy

Inspiration:
- **Pure white backgrounds** in light mode (sidebar included, no gray tints)
- **Primary is black** (light) / white (dark) — NOT a brand color
- **Accent `#C8F23E`** (lime) reserved for highlights, CTAs, active emphasis — used sparingly. Because lime is a light color, `accent-foreground` is black (`#000000`), not white. When the accent is used as **text on a light background** (links, `hover:text-*`), use `text-accent-strong` instead of `text-accent` — it resolves to a darker lime (`#AEDB1F`) in light mode for readable contrast, and to the bright lime in dark mode
- **Semantic colors only**: green for success/positive, red for destructive/negative
- No gradients, no heavy shadows, no decorative borders
- Strong visual hierarchy through font weight and size, not color

## Quick Reference

### Color Tokens

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `primary` | `#000000` | `#FAFAFA` | Buttons, headings, main actions |
| `primary-foreground` | `#FFFFFF` | `#0A0A0A` | Text on primary bg |
| `secondary` | `#F5F5F5` | `#1A1A1A` | Secondary surfaces, hover states |
| `muted` | `#F5F5F5` | `#1A1A1A` | Subdued backgrounds |
| `muted-foreground` | `#6B6B6B` | `#A0A0A0` | Secondary text, captions |
| `accent` | `#C8F23E` | `#C8F23E` | Highlights, CTAs (use sparingly) |
| `accent-foreground` | `#000000` | `#000000` | Text on accent bg (black — lime is light) |
| `accent-strong` | `#AEDB1F` | `#C8F23E` | Accent as TEXT on light bg (links, hover). Darker in light mode for contrast; bright lime in dark mode |
| `destructive` | `#D32F2F` | `#D32F2F` | Errors, deletions |
| `success` | `#00C853` | `#00C853` | Positive values, confirmations |
| `background` | `#FFFFFF` | `#0A0A0A` | Page background |
| `foreground` | `#000000` | `#FAFAFA` | Default text |
| `border` | `#EEEEEE` | `#222222` | Borders, dividers |
| `input` | `#E0E0E0` | `#2A2A2A` | Input borders |
| `sidebar` | `#FFFFFF` | `#0A0A0A` | Same as background |

### Typography

- **Font**: Inter (loaded via `next/font/google`, variable `--font-inter`)
- **H1**: `text-3xl font-semibold tracking-tight` (30px)
- **H2**: `text-2xl font-semibold tracking-tight` (24px)
- **H3**: `text-xl font-semibold` (20px)
- **Body**: `text-sm` or `text-base` (14-16px)
- **Caption/Meta**: `text-xs text-muted-foreground` (12px)
- Never use decorative fonts or excessive weights

### Spacing

8px grid system. Use Tailwind's default scale which aligns at:
- `gap-1` / `p-1` = 4px (xs)
- `gap-2` / `p-2` = 8px (sm)
- `gap-4` / `p-4` = 16px (md)
- `gap-6` / `p-6` = 24px (lg)
- `gap-8` / `p-8` = 32px (xl)

### Border Radius

- `rounded-sm` = 8px — inputs, small elements
- `rounded-md` = 12px — cards, buttons
- `rounded-lg` = 16px — large containers, modals

### Shadows

Subtle only. Use `shadow-[0_2px_8px_rgba(0,0,0,0.04)]` for card elevation. No heavy shadows.

## Tech Stack

| Layer | Tool | Notes |
|-------|------|-------|
| Framework | Next.js 15 (App Router) | `packages/web/` |
| UI | React 19 | Server + Client components |
| Styling | Tailwind CSS 4 | CSS-first config via `@theme inline` in globals.css |
| Animations | tw-animate-css | Required for shadcn/ui transitions (`animate-in`, `fade-*`, `zoom-*`, `slide-*`) |
| Components | shadcn/ui (new-york) | Source-owned in `src/components/ui/` |
| Icons | lucide-react | Line icons, 1.5-2px stroke |
| Theme | next-themes | localStorage key `"theme"`, class strategy |
| Utilities | clsx + tailwind-merge | Via `cn()` in `src/lib/utils.ts` |
| i18n | Custom React Context | `src/lib/i18n/` — flat JSON, `useI18n()` hook, type-safe keys |

## File Structure

```
packages/web/src/
  app/
    globals.css                    # All design tokens (@theme inline + :root + .dark)
    layout.tsx                     # Root: Inter font, ThemeProvider
    (admin)/
      layout.tsx                   # Admin shell: SidebarProvider + Sidebar + Header
      page.tsx                     # Dashboard
      <entity>/                    # CRUD feature (e.g. skills/)
        page.tsx                   # List page
        new/page.tsx               # Create (thin wrapper → shared form)
        [param]/page.tsx           # Edit/detail (fetches → shared form)
        _components/               # Co-located private components
          <entity>-form.tsx        # Shared create/edit form
  components/
    ui/                            # shadcn/ui components (DO NOT manually edit)
      button.tsx, sidebar.tsx, sheet.tsx, tooltip.tsx, ...
    layout/                        # App-specific layout components
      app-sidebar.tsx              # Sidebar navigation structure
      nav-main.tsx                 # Nav items with active state
      header.tsx                   # Top bar with theme toggle
    theme-provider.tsx             # next-themes wrapper
  lib/
    utils.ts                       # cn() helper
    i18n/                          # Internationalization
      types.ts                     # Locale, TranslationKey types
      context.tsx                  # I18nProvider + useI18n() hook
      locales/
        en.json                    # English (type source of truth)
        it.json                    # Italian
  hooks/
    use-mobile.tsx                 # Viewport breakpoint hook
```

## How to Add a New Page

1. Create `src/app/(admin)/<route>/page.tsx`
2. Add translation keys to **both** `en.json` and `it.json` (e.g. `"myPage.title"`, `"myPage.subtitle"`)
3. Use the standard heading pattern with `t()`:
```tsx
"use client";
import { useI18n } from "@/lib/i18n/context";

export default function MyPage() {
  const { t } = useI18n();
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">{t("myPage.title")}</h1>
      <p className="mt-2 text-muted-foreground">{t("myPage.subtitle")}</p>
    </div>
  );
}
```
4. Add navigation entry in `src/components/layout/app-sidebar.tsx` (import icon from lucide-react, add to the appropriate nav items array)
5. The `(admin)` route group automatically applies sidebar layout — no extra config needed

## How to Add a New shadcn/ui Component

```bash
cd packages/web && npx shadcn@latest add <component-name> --yes --overwrite
```

After running the CLI:
- Check if `globals.css` was modified — the CLI may inject default `:root` variables that **conflict** with our tokens. Remove any auto-added `:root` or `.dark` blocks that duplicate our existing tokens.
- Check if it created a duplicate hook file (e.g., `use-mobile.ts` vs our `use-mobile.tsx`). Remove duplicates.
- The `components.json` at `packages/web/components.json` controls CLI behavior (style: new-york, aliases, etc.)

## How to Add a Custom Component

1. Place in `src/components/` (not in `ui/` — that's shadcn territory)
2. Use `cn()` for class merging
3. Use design tokens via Tailwind classes (`bg-primary`, `text-muted-foreground`, etc.)
4. Mark with `"use client"` only if it uses hooks, event handlers, or browser APIs
5. Follow existing patterns — look at `components/layout/` for examples

## Theme System

- **Provider**: `next-themes` wraps the app in `src/app/layout.tsx`
- **Strategy**: `attribute="class"` — adds `.dark` class to `<html>`
- **Storage**: `localStorage` key `"theme"`
- **Default**: `"light"`, system preference disabled
- **Toggle**: `ThemeToggle` component in header uses `useTheme()` hook
- **CSS**: Light tokens in `:root`, dark tokens in `.dark` — both in `globals.css`
- **Adding tokens**: Add to BOTH `:root` and `.dark` blocks, then map in `@theme inline`

## Internationalization (i18n)

All user-facing text **must** be translated. No hardcoded strings in components.

### Architecture

- **No external library** — lightweight custom implementation using React Context
- **Client-side only** — locale stored in `localStorage` (key `"locale"`)
- **Type-safe keys** — `TranslationKey` type derived from `en.json`, checked at compile time
- **Default locale**: `"it"` (Italian)
- **Supported locales**: `"it"`, `"en"`

### File Structure

```
packages/web/src/lib/i18n/
  types.ts              # Locale, TranslationKey, Translations types + constants
  context.tsx           # I18nProvider + useI18n() hook
  locales/
    en.json             # English translations (source of truth for type inference)
    it.json             # Italian translations
```

### How to Use in Components

1. Import the hook and (if needed) the key type:

```tsx
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
```

2. Destructure `t` (and optionally `locale`, `setLocale`):

```tsx
const { t } = useI18n();
```

3. Use `t()` for all user-facing text:

```tsx
<h1>{t("conversations.title")}</h1>
<p>{t("instances.time.minutesAgo", { count: 5 })}</p>
```

### Translation Key Conventions

Keys use **flat dot-notation** organized by feature domain:

| Prefix | Scope |
|--------|-------|
| `nav.*` | Sidebar navigation labels |
| `dashboard.*` | Dashboard page |
| `conversations.*` | Conversations list page |
| `conversations.detail.*` | Conversation detail page |
| `instances.*` | Instances list + creation |
| `instances.detail.*` | Instance detail page |
| `general.*` | Instance general tab fields |
| `prompts.*` | Instance prompts tab |
| `tools.*` | Instance tools tab |
| `skills.*` | Skills CRUD + instance skills tab |
| `skills.env.*` | Skill env variable dialog |
| `memory.*` | Memory page |
| `settings.*` | Settings page |
| `common.*` | Shared labels: save, cancel, delete, loading, etc. |

### How to Add New Translation Keys

1. Add the key to **both** `en.json` and `it.json` — the build will fail if `en.json` has a key missing from `it.json` (type mismatch)
2. Use `{param}` syntax for dynamic values: `"Created {time}"` → `t("key", { time: value })`
3. Group related keys under the same domain prefix
4. Reuse `common.*` keys for shared labels (Save, Cancel, Delete, Loading...)
5. Reuse `instances.time.*` keys for relative time formatting across pages

### Language Toggle

The `LangToggle` component in the header renders a dropdown with rectangular SVG flag icons (rounded corners). It reads/writes locale via `useI18n()`.

Location: `src/components/layout/lang-toggle.tsx`

### Common Mistakes

| Mistake | Fix |
|---------|-----|
| Hardcoding user-facing strings | Always use `t("key")` — no raw strings in JSX |
| Adding key to `en.json` only | Add to **both** `en.json` and `it.json` |
| Using a format like `t("Just now")` | Keys are dot-notation identifiers, not the text itself |
| Creating a new time formatting function | Reuse `instances.time.*` keys with `{count}` param |
| Forgetting to pass `t` to utility functions | Pure functions outside components need `t` passed as argument |

## CRUD Page Architecture

CRUD features follow a three-file route structure under `src/app/(admin)/<entity>/`:

```
(admin)/
  <entity>/
    page.tsx              # List page (index)
    new/
      page.tsx            # Create page (thin wrapper)
    [param]/
      page.tsx            # Edit/detail page (fetches by param)
    _components/
      <entity>-form.tsx   # Shared create/edit form component
```

- `_components/` (underscore prefix) is a Next.js App Router convention — private to the route group, not routable
- `new/page.tsx` is a thin 3-line wrapper that delegates to the shared form
- `[param]/page.tsx` owns data fetching and passes `initialData` to the shared form

```tsx
// new/page.tsx — thin wrapper
import { EntityForm } from "../_components/entity-form";
export default function NewEntityPage() {
  return <EntityForm mode="create" />;
}
```

## Data Fetching Pattern

All pages use `"use client"` + `useEffect` + raw `fetch()`. No React Query, no SWR, no server-side data fetching.

Engine URL is a module-level constant per file (no shared API client yet — intentional MVP):

```tsx
const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4000";
```

Standard fetch pattern:

```tsx
const [items, setItems] = useState<ItemSummary[]>([]);
const [loading, setLoading] = useState(true);

const fetchItems = async () => {
  try {
    const res = await fetch(`${ENGINE_URL}/api/<entity>`);
    const data = await res.json();
    setItems(Array.isArray(data.items) ? data.items : []);
  } catch (err) {
    console.error("Failed to fetch items:", err);
  } finally {
    setLoading(false);
  }
};

useEffect(() => { fetchItems(); }, []);
```

Key: `loading` initializes to `true`, `setLoading(false)` lives in `finally`.

## Button Variant Convention

| Context | Variant | Appearance | Example |
|---------|---------|------------|---------|
| Primary page action (header CTA) | default (no variant) | Black bg, white text | `+ New Instance`, `+ New Skill`, `Save changes` |
| Empty state CTA | `variant="outline"` | White bg, black border | `Create your first instance` |
| Inline/row actions | `variant="ghost" size="icon"` | Transparent, icon only | Edit pencil, delete trash |
| Secondary/cancel actions | `variant="outline"` or `variant="ghost"` | Subtle | `Cancel`, `Back` |

**Rule:** The main action button in a page header (like "+ New X") ALWAYS uses the default variant (primary/black). Never use `variant="outline"` for primary page actions — outline is reserved for empty states and secondary actions.

## Page Layout Pattern

### List Page Header

Split layout — title + subtitle left, primary CTA right:

```tsx
<div className="flex items-center justify-between">
  <div>
    <h1 className="text-3xl font-semibold tracking-tight">Skills</h1>
    <p className="mt-1 text-muted-foreground">Manage your global skills library.</p>
  </div>
  <Button asChild>
    <Link href="/skills/new">
      <Plus className="mr-2 size-4" />
      New Skill
    </Link>
  </Button>
</div>
```

### Form Page Header

Save button in header row (top-right), not at the bottom of the form:

```tsx
<div className="flex items-center justify-between">
  <h1 className="text-3xl font-semibold tracking-tight">
    {mode === "create" ? "New Skill" : initialData?.name}
  </h1>
  <Button onClick={handleSave} disabled={saving}>
    {saving ? "Saving..." : "Save"}
  </Button>
</div>
```

### Content Area

Content separated from header by `mt-6`. Forms constrained to `max-w-2xl`:

```tsx
<div className="mt-6 space-y-6 max-w-2xl">
  {/* form fields */}
</div>
```

## List Table Pattern

Use shadcn `Table` components. Standard columns: name (clickable link), description, actions.

```tsx
<Table className="mt-6">
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead>Description</TableHead>
      <TableHead className="w-[100px]">Actions</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {items.map((item) => (
      <TableRow key={item.name}>
        <TableCell className="font-medium">
          <Link href={`/<entity>/${item.name}`}
            className="underline underline-offset-4 hover:text-accent-strong">
            {item.name}
          </Link>
        </TableCell>
        <TableCell className="text-muted-foreground">{item.description}</TableCell>
        <TableCell>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" asChild>
              <Link href={`/<entity>/${item.name}`}><Pencil className="size-4" /></Link>
            </Button>
            {/* delete — see Delete Confirmation Pattern */}
          </div>
        </TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

- Name cell: `font-medium`, link with `underline underline-offset-4 hover:text-accent-strong`
- Description cell: `text-muted-foreground`
- Actions column: fixed `w-[100px]`, ghost icon buttons with `size-4` icons

## Empty State Pattern

Shown when list is empty. Centered, muted text, outline CTA:

```tsx
<div className="mt-16 flex flex-col items-center text-center">
  <p className="text-muted-foreground">No skills yet.</p>
  <Button asChild className="mt-4" variant="outline">
    <Link href="/skills/new">Create your first skill</Link>
  </Button>
</div>
```

- Offset: `mt-16` from header
- CTA: `variant="outline"`, not primary black

## Chart / Card Empty State Pattern

Dashboard charts and data cards must **always render their Card shell**, even when there is no data. Never return `null` or hide the component — this keeps the layout stable and avoids visual jumps.

Inside the card, replace the chart area with a centered muted message at the chart's normal height:

```tsx
<Card>
  <CardHeader className="pb-2">
    <CardTitle className="text-sm font-medium">{t("analytics.charts.myChart")}</CardTitle>
  </CardHeader>
  <CardContent>
    {data.length === 0 ? (
      <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
        {t("analytics.noData")}
      </div>
    ) : (
      <ChartContainer config={chartConfig} className="h-[250px] w-full">
        {/* ... chart content ... */}
      </ChartContainer>
    )}
  </CardContent>
</Card>
```

Key rules:
- Use the same `h-[250px]` (or whatever the chart's normal height is) for the empty placeholder
- Use `text-sm text-muted-foreground` for the message
- Use i18n key `analytics.noData` for the message text
- The parent dashboard should always render all chart components — conditional rendering based on data availability belongs **inside** each chart, not in the dashboard

## Loading State Pattern

Text-only, no skeletons or spinners. Page title always rendered on list pages to prevent layout flash.

```tsx
// List page — title stays, body shows loading
if (loading) {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">Skills</h1>
      <p className="mt-2 text-muted-foreground">Loading...</p>
    </div>
  );
}

// Detail/edit page — title not yet known
if (loading) return <div><h1 className="text-3xl font-semibold tracking-tight">Loading...</h1></div>;

// Not-found state (after load completes with no data)
if (!entity) return <div><h1 className="text-3xl font-semibold tracking-tight">Skill not found</h1></div>;
```

## Delete Confirmation Pattern

Use `AlertDialog` (not `window.confirm`). Trigger is a ghost icon button. After deletion, update local state directly:

```tsx
<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant="ghost" size="icon"><Trash2 className="size-4" /></Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete skill</AlertDialogTitle>
      <AlertDialogDescription>
        This will permanently remove &quot;{item.name}&quot; from the library. This action cannot be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={() => handleDelete(item.name)}>Delete</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

```tsx
const handleDelete = async (name: string) => {
  try {
    await fetch(`${ENGINE_URL}/api/<entity>/${name}`, { method: "DELETE" });
    setItems((prev) => prev.filter((s) => s.name !== name));
  } catch (err) {
    console.error("Failed to delete:", err);
  }
};
```

## Shared Create/Edit Form Pattern

Single component handles both modes via `mode` prop:

```tsx
interface EntityFormProps {
  mode: "create" | "edit";
  initialData?: { name: string; description: string; /* ... */ };
}

export function EntityForm({ mode, initialData }: EntityFormProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(initialData?.name ?? "");
  // ... one useState per field

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = mode === "create"
        ? `${ENGINE_URL}/api/<entity>`
        : `${ENGINE_URL}/api/<entity>/${initialData!.name}`;
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? `HTTP ${res.status}`);
      }
      router.push("/<entity>");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };
}
```

No form library (no react-hook-form, no client-side zod). Validation lives in the engine.

### Slug / Identifier Fields

Normalize on every keystroke, lock in edit mode:

```tsx
<Input
  value={name}
  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
  readOnly={mode === "edit"}
  className={mode === "edit" ? "opacity-60" : ""}
/>
```

### Form Field Layout

Each field: `space-y-2` wrapping `Label` + input:

```tsx
<div className="space-y-2">
  <Label htmlFor="description">Description</Label>
  <Input id="description" value={description} onChange={...} />
</div>
```

### Large Text / Markdown Fields

```tsx
<Textarea
  value={content}
  onChange={(e) => setContent(e.target.value)}
  className="min-h-[400px] font-mono text-sm"
/>
```

## Type Definitions Convention

Types are defined inline per-file, not in a shared package. Name them `<Entity>Summary` (list views) and `<Entity>Detail` (detail/edit views):

```tsx
interface SkillSummary { name: string; description: string; }
interface SkillDetail  { name: string; description: string; content: string; }
```

Types mirror the engine API response shape exactly. No codegen — update both sides manually when API changes.

## Error Handling Strategy (Current MVP)

Intentionally pragmatic. Replace `alert()` with toasts when a toast system is added.

| Scenario | Behavior |
|----------|----------|
| Fetch error (list/detail) | `console.error` only, no UI feedback |
| Save/mutation error | `alert()` with the error message |
| Delete error | `console.error` only |
| 404 on detail page | Renders "Entity not found" heading |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using accent/lime as primary color | Primary is black/white. Accent is for rare highlights only |
| Giving sidebar a different background | Sidebar bg = same as page background (white/dark) |
| Using `bg-gray-100` instead of tokens | Always use semantic tokens: `bg-secondary`, `bg-muted` |
| Adding color for decoration | Only use color semantically (success, error, accent CTA) |
| Editing files in `components/ui/` manually | Use shadcn CLI. Those files are managed by shadcn |
| Hardcoding hex colors in components | Use Tailwind token classes from globals.css |
| Forgetting dark mode when adding tokens | Every new CSS var must go in both `:root` and `.dark` |
| Using `rounded-xl` or arbitrary radius | Stick to `rounded-sm` (8px), `rounded-md` (12px), `rounded-lg` (16px) |
| Placing Save button at bottom of form | Save button belongs in the header row (top-right), next to the page title |
| Using `window.confirm` for delete | Use shadcn `AlertDialog` — it supports dark theme and matches the design system |
| Fetching data in a Server Component | All data fetching is `useEffect` + `fetch()` in `"use client"` components |
| Separate create and edit form components | One component with `mode: "create" \| "edit"` and optional `initialData` |
| Allowing slug fields to be edited in edit mode | Apply `readOnly` + `className="opacity-60"` to identifier fields in edit mode |
| Using a single form state object | Use individual `useState` per field |
| Creating routes inside `_components/` | `_components/` is a non-routable private directory — never nest pages inside it |
| Hardcoding user-facing strings | All text must use `t("key")` via `useI18n()` — no raw strings in JSX |
| Adding i18n key to only one locale file | Every key must exist in **both** `en.json` and `it.json` |
| Using `variant="outline"` for primary page CTA | Primary action buttons (e.g. `+ New X`) use default variant (black). Outline is for empty states and secondary actions only |
| Adding `cursor-pointer` to individual components | `cursor: pointer` is applied globally via `@layer base` in globals.css for all interactive elements (button, a, select, etc.) |
| Removing `tw-animate-css` import | Required for all shadcn/ui component animations (Dialog, Sheet, AlertDialog transitions) |
| Using native HTML `<select>` / `<option>` | Always use shadcn `Select` (`SelectTrigger`, `SelectContent`, `SelectItem`) — native selects don't match the design system and break dark mode theming |
| Hiding a chart/card when data is empty | Always render the Card shell; show centered `text-sm text-muted-foreground` "no data" message inside at the chart's normal height |
