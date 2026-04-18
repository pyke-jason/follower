---
name: button-with-icon
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/button-with-icon.tsx
---

# button-with-icon

```tsx
import { IconGitBranch } from "@tabler/icons-react"

import { Button } from "@/registry/new-york-v4/ui/button"

export default function ButtonWithIcon() {
  return (
    <Button variant="outline" size="sm">
      <IconGitBranch /> New Branch
    </Button>
  )
}
```
