---
title: Import UI Primitives By Deep Path
impact: HIGH
impactDescription: keeps a component library's dependencies out of routes that do not use it
tags: bundle, imports, barrel, ui
---

## Import UI Primitives By Deep Path

A component library where every primitive is its own module — the shadcn/ui shape,
and the shape most in-repo `packages/ui` workspaces take — should be imported by deep
path. A route then pulls in exactly the primitives it uses.

A barrel import, or adding a barrel that re-exports everything, pulls the whole
library and its transitive dependencies (for a Radix-based kit, ~25 packages) into
every route that touches one button. Tree-shaking does not reliably save you here:
the library is often source-only with no build step, and a single side-effecting
module in the barrel's graph defeats it.

**Incorrect (drags the library in):**

```tsx
import { Button, Input, Badge } from "@acme/ui";
```

**Correct (one module each):**

```tsx
import { Button } from "@acme/ui/components/ui/button";
import { Input } from "@acme/ui/components/ui/input";
import { Badge } from "@acme/ui/components/ui/badge";
import { cn } from "@acme/ui/lib/utils";
```

**Do not add a barrel** to make the imports shorter. The deep paths are the
mechanism, not a style preference.

Two related notes:

- **Check whether your repo has a legacy copy.** A local `app/views/components/ui`
  alongside a shared `packages/ui` means two divergent sets of the same primitives;
  pick the shared one and say so in `CLAUDE.md`.
- **Keep import paths statically analyzable.** A computed specifier defeats
  tree-shaking and widens what the build has to trace.

This matters more under gemi than under a bundler that ships one chunk: each view is
its own build entry (`preserveEntrySignatures: "strict"`), so a barrel import in one
view inflates that view's chunk and every chunk that shares its graph.
