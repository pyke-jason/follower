---
name: input-with-button
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/input-with-button.tsx
---

# input-with-button

```tsx
import { Button } from "@/registry/new-york-v4/ui/button"
import { Input } from "@/registry/new-york-v4/ui/input"

export default function InputWithButton() {
  return (
    <div className="flex w-full max-w-sm items-center gap-2">
      <Input type="email" placeholder="Email" />
      <Button type="submit" variant="outline">
        Subscribe
      </Button>
    </div>
  )
}
```
