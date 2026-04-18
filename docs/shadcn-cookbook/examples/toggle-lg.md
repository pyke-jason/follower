---
name: toggle-lg
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/toggle-lg.tsx
---

# toggle-lg

```tsx
import { Italic } from "lucide-react"

import { Toggle } from "@/registry/new-york-v4/ui/toggle"

export default function ToggleLg() {
  return (
    <Toggle size="lg" aria-label="Toggle italic">
      <Italic />
    </Toggle>
  )
}
```
