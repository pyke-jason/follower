---
name: button-rounded
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/button-rounded.tsx
---

# button-rounded

```tsx
import { ArrowUpIcon } from "lucide-react"

import { Button } from "@/registry/new-york-v4/ui/button"

export default function ButtonRounded() {
  return (
    <div className="flex flex-col gap-8">
      <Button variant="outline" size="icon" className="rounded-full">
        <ArrowUpIcon />
      </Button>
    </div>
  )
}
```
