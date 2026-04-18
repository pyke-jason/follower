---
name: skeleton
type: registry:ui
registry: "@shadcn"
dependencies: []
---
# skeleton

No description.

## Files

### registry/new-york-v4/ui/skeleton.tsx

```tsx
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }

```
