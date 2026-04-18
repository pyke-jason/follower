---
name: textarea-with-label
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/textarea-with-label.tsx
---

# textarea-with-label

```tsx
import { Label } from "@/registry/new-york-v4/ui/label"
import { Textarea } from "@/registry/new-york-v4/ui/textarea"

export default function TextareaWithLabel() {
  return (
    <div className="grid w-full gap-3">
      <Label htmlFor="message">Your message</Label>
      <Textarea placeholder="Type your message here." id="message" />
    </div>
  )
}
```
