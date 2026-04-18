---
name: skeleton-card
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/skeleton-card.tsx
---

# skeleton-card

```tsx
import { Skeleton } from "@/registry/new-york-v4/ui/skeleton"

export default function SkeletonCard() {
  return (
    <div className="flex flex-col space-y-3">
      <Skeleton className="h-[125px] w-[250px] rounded-xl" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-[250px]" />
        <Skeleton className="h-4 w-[200px]" />
      </div>
    </div>
  )
}
```
