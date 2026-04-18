---
name: button-demo
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/button-demo.tsx
---

# button-demo

```tsx
import { ArrowUpIcon } from "lucide-react"

import { Button } from "@/registry/new-york-v4/ui/button"

export default function ButtonDemo() {
  return (
    <div className="flex flex-wrap items-center gap-2 md:flex-row">
      <Button variant="outline">Button</Button>
      <Button variant="outline" size="icon" aria-label="Submit">
        <ArrowUpIcon />
      </Button>
    </div>
  )
}
```
