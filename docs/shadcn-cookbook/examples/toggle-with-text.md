---
name: toggle-with-text
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/toggle-with-text.tsx
---

# toggle-with-text

```tsx
import { Italic } from "lucide-react"

import { Toggle } from "@/registry/new-york-v4/ui/toggle"

export default function ToggleWithText() {
  return (
    <Toggle aria-label="Toggle italic">
      <Italic />
      Italic
    </Toggle>
  )
}
```
