---
name: spinner-badge
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/spinner-badge.tsx
---

# spinner-badge

```tsx
import { Badge } from "@/registry/new-york-v4/ui/badge"
import { Spinner } from "@/registry/new-york-v4/ui/spinner"

export default function SpinnerBadge() {
  return (
    <div className="flex items-center gap-4 [--radius:1.2rem]">
      <Badge>
        <Spinner />
        Syncing
      </Badge>
      <Badge variant="secondary">
        <Spinner />
        Updating
      </Badge>
      <Badge variant="outline">
        <Spinner />
        Processing
      </Badge>
    </div>
  )
}
```
