---
name: sonner-demo
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/sonner-demo.tsx
---

# sonner-demo

```tsx
"use client"

import { toast } from "sonner"

import { Button } from "@/registry/new-york-v4/ui/button"

export default function SonnerDemo() {
  return (
    <Button
      variant="outline"
      onClick={() =>
        toast("Event has been created", {
          description: "Sunday, December 03, 2023 at 9:00 AM",
          action: {
            label: "Undo",
            onClick: () => console.log("Undo"),
          },
        })
      }
    >
      Show Toast
    </Button>
  )
}
```
