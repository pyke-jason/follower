---
name: button-loading
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/button-loading.tsx
---

# button-loading

```tsx
import { Button } from "@/registry/new-york-v4/ui/button"
import { Spinner } from "@/registry/new-york-v4/ui/spinner"

export default function ButtonLoading() {
  return (
    <Button size="sm" variant="outline" disabled>
      <Spinner />
      Submit
    </Button>
  )
}
```
