---
name: input-with-label
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/input-with-label.tsx
---

# input-with-label

```tsx
import { Input } from "@/registry/new-york-v4/ui/input"
import { Label } from "@/registry/new-york-v4/ui/label"

export default function InputWithLabel() {
  return (
    <div className="grid w-full max-w-sm items-center gap-3">
      <Label htmlFor="email">Email</Label>
      <Input type="email" id="email" placeholder="Email" />
    </div>
  )
}
```
