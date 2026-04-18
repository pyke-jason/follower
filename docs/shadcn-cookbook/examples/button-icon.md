---
name: button-icon
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/button-icon.tsx
---

# button-icon

```tsx
import { CircleFadingArrowUpIcon } from "lucide-react"

import { Button } from "@/registry/new-york-v4/ui/button"

export default function ButtonIcon() {
  return (
    <Button variant="outline" size="icon">
      <CircleFadingArrowUpIcon />
    </Button>
  )
}
```
