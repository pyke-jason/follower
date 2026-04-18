---
name: spinner
type: registry:ui
registry: "@shadcn"
dependencies: ["class-variance-authority"]
---
# spinner

No description.

## Files

### registry/new-york-v4/ui/spinner.tsx

```tsx
import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }

```
