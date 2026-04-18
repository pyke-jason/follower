---
name: kbd-demo
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/kbd-demo.tsx
---

# kbd-demo

```tsx
import { Kbd, KbdGroup } from "@/registry/new-york-v4/ui/kbd"

export default function KbdDemo() {
  return (
    <div className="flex flex-col items-center gap-4">
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>⇧</Kbd>
        <Kbd>⌥</Kbd>
        <Kbd>⌃</Kbd>
      </KbdGroup>
      <KbdGroup>
        <Kbd>Ctrl</Kbd>
        <span>+</span>
        <Kbd>B</Kbd>
      </KbdGroup>
    </div>
  )
}
```
