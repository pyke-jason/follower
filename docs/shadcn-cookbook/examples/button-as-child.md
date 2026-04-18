---
name: button-as-child
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/button-as-child.tsx
---

# button-as-child

```tsx
import Link from "next/link"

import { Button } from "@/registry/new-york-v4/ui/button"

export default function ButtonAsChild() {
  return (
    <Button asChild>
      <Link href="/login">Login</Link>
    </Button>
  )
}
```
