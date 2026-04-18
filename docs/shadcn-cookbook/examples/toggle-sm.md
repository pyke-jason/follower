---
name: toggle-sm
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/toggle-sm.tsx
---

# toggle-sm

```tsx
import { Italic } from "lucide-react"

import { Toggle } from "@/registry/new-york-v4/ui/toggle"

export default function ToggleSm() {
  return (
    <Toggle size="sm" aria-label="Toggle italic">
      <Italic />
    </Toggle>
  )
}
```
