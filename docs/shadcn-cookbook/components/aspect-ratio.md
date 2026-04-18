---
name: aspect-ratio
type: registry:ui
registry: "@shadcn"
dependencies: ["radix-ui"]
---
# aspect-ratio

No description.

## Files

### registry/new-york-v4/ui/aspect-ratio.tsx

```tsx
"use client"

import { AspectRatio as AspectRatioPrimitive } from "radix-ui"

function AspectRatio({
  ...props
}: React.ComponentProps<typeof AspectRatioPrimitive.Root>) {
  return <AspectRatioPrimitive.Root data-slot="aspect-ratio" {...props} />
}

export { AspectRatio }

```
