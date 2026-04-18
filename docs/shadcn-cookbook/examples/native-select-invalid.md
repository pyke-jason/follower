---
name: native-select-invalid
type: example
registry: "@shadcn"
source: registry/new-york-v4/examples/native-select-invalid.tsx
---

# native-select-invalid

```tsx
import {
  NativeSelect,
  NativeSelectOption,
} from "@/registry/new-york-v4/ui/native-select"

export default function NativeSelectInvalid() {
  return (
    <NativeSelect aria-invalid="true">
      <NativeSelectOption value="">Select role</NativeSelectOption>
      <NativeSelectOption value="admin">Admin</NativeSelectOption>
      <NativeSelectOption value="editor">Editor</NativeSelectOption>
      <NativeSelectOption value="viewer">Viewer</NativeSelectOption>
      <NativeSelectOption value="guest">Guest</NativeSelectOption>
    </NativeSelect>
  )
}
```
