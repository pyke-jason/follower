---
name: textarea-with-button
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/textarea-with-button.tsx
---

# textarea-with-button

```tsx
import { Button } from "@/registry/new-york-v4/ui/button"
import { Textarea } from "@/registry/new-york-v4/ui/textarea"

export default function TextareaWithButton() {
  return (
    <div className="grid w-full gap-2">
      <Textarea placeholder="Type your message here." />
      <Button>Send message</Button>
    </div>
  )
}
```
