---
name: switch-demo
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/switch-demo.tsx
---

# switch-demo

```tsx
import { Label } from "@/registry/new-york-v4/ui/label"
import { Switch } from "@/registry/new-york-v4/ui/switch"

export default function SwitchDemo() {
  return (
    <div className="flex items-center space-x-2">
      <Switch id="airplane-mode" />
      <Label htmlFor="airplane-mode">Airplane Mode</Label>
    </div>
  )
}
```
