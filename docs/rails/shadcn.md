# shadcn/ui Component Guide

All UI primitives live in `web/components/ui/`. **DO NOT MODIFY** these files — they are managed by shadcn. To add a new component: `npx shadcn@latest add <component>`.

**The rule:** If shadcn has a component for it, use it. No hand-rolled buttons, selects, tables, modals, tooltips, badges, or inputs. No raw HTML `<button>`, `<select>`, `<table>`, `<input>`, or `<textarea>` elements in app code.

## When to use what

### Layout & Containers

| Need | Component | Not this |
|------|-----------|----------|
| Grouped content with header | `Card` + `CardHeader` + `CardContent` | `<div className="border rounded-lg bg-card">` |
| Divider line | `Separator` | `<hr>`, `border-b`, `<div className="h-px">` |
| Custom scrollbar | `ScrollArea` | `overflow-auto` with custom scrollbar CSS |
| Tabbed sections | `Tabs` + `TabsList` + `TabsTrigger` + `TabsContent` | Custom state + button group |
| Side panel (persistent) | `ResizablePanelGroup` | Fixed div with transition, `Sheet` |
| Side panel (temporary, mobile) | `Drawer` | Fixed div with transition |
| Modal | `Dialog` | Custom overlay + positioned div |
| Collapsible section | `Collapsible` | Custom state + height transition |

### Data Display

| Need | Component | Not this |
|------|-----------|----------|
| Data table | `Table` + `TableHeader` + `TableRow` + `TableHead` + `TableCell` | Raw `<table>` + `<th>` + `<td>` |
| Status label | `Badge` (import from `app/components/badge.tsx` for semantic colors) | Inline `<span>` with color classes |
| Hover info | `Tooltip` + `TooltipTrigger` + `TooltipContent` | `title` attribute or custom hover div |
| Rich hover preview | `HoverCard` | Custom positioned div on hover |
| Loading placeholder | `Skeleton` | Custom `animate-pulse` div |
| Progress bar | `Progress` | `<div>` with width percentage |
| Chart | `ChartContainer` + `ChartTooltip` + `ChartTooltipContent` (Recharts wrappers) | Raw Recharts without shadcn wrappers |

### Forms & Inputs

| Need | Component | Not this |
|------|-----------|----------|
| Text field | `Input` | Raw `<input>` |
| Multi-line text | `Textarea` | Raw `<textarea>` |
| Dropdown select | `Select` + `SelectTrigger` + `SelectContent` + `SelectItem` | Raw `<select>` or custom dropdown |
| Lightweight select | `NativeSelect` | Raw `<select>` without styling |
| Searchable select | `Combobox` + `ComboboxInput` + `ComboboxContent` + `ComboboxItem` | Custom input + filtered list |
| Searchable multi-select | `Combobox` + `ComboboxChips` + `ComboboxChip` | Custom chips + input |
| Toggle (on/off) | `Switch` | Custom checkbox styled as toggle |
| Checkbox | `Checkbox` | Raw `<input type="checkbox">` |
| Radio buttons | `RadioGroup` + `RadioGroupItem` | Raw `<input type="radio">` |
| Range slider | `Slider` | Raw `<input type="range">` |
| Form with validation | `Form` + `FormField` + `FormItem` + `FormControl` + `FormMessage` | Manual error state management |
| Form label | `Label` | Raw `<label>` |

### Actions & Navigation

| Need | Component | Not this |
|------|-----------|----------|
| Button | `Button` with variant (`default`, `destructive`, `outline`, `secondary`, `ghost`, `link`) | Raw `<button>` with custom classes |
| Toggle button | `Toggle` | Button with manual active state |
| Toggle button group | `ToggleGroup` + `ToggleGroupItem` | Multiple buttons with shared state |
| Context/action menu | `DropdownMenu` + `DropdownMenuItem` | Custom positioned div |
| Command palette | `Command` + `CommandInput` + `CommandList` + `CommandItem` | Custom search + list |

## Key patterns

### Button variants
```tsx
<Button variant="default">Primary</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="ghost" size="xs">Small ghost</Button>
<Button variant="destructive">Delete</Button>
<Button variant="outline" size="icon"><Icon /></Button>

// As link:
<Button variant="ghost" asChild>
  <Link to="/somewhere">Navigate</Link>
</Button>
```

### Select
```tsx
<Select value={value} onValueChange={setValue}>
  <SelectTrigger size="sm">
    <SelectValue placeholder="Pick one" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="a">Option A</SelectItem>
    <SelectItem value="b">Option B</SelectItem>
  </SelectContent>
</Select>
```

### Tabs
```tsx
<Tabs defaultValue="trades">
  <TabsList>
    <TabsTrigger value="trades">Trades</TabsTrigger>
    <TabsTrigger value="messages">Messages</TabsTrigger>
  </TabsList>
  <TabsContent value="trades">...</TabsContent>
  <TabsContent value="messages">...</TabsContent>
</Tabs>
```

### Table
```tsx
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead className="text-right">Amount</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>AAPL</TableCell>
      <TableCell className="text-right font-mono">$182.50</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

### Dialog
```tsx
<Dialog>
  <DialogTrigger asChild>
    <Button variant="outline">Open</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description text.</DialogDescription>
    </DialogHeader>
    {/* content */}
    <DialogFooter>
      <Button>Confirm</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

## What NOT to do

```tsx
// BAD: raw HTML elements
<button className="px-3 py-1.5 rounded bg-primary text-white">Click</button>
<select onChange={...}><option>A</option></select>
<input type="text" className="border rounded px-2" />
<table><tr><td>data</td></tr></table>

// GOOD: shadcn components
<Button>Click</Button>
<Select onValueChange={...}>...</Select>
<Input />
<Table><TableBody><TableRow><TableCell>data</TableCell></TableRow></TableBody></Table>
```

```tsx
// BAD: custom dropdown
<div className="relative">
  <button onClick={() => setOpen(!open)}>Menu</button>
  {open && <div className="absolute top-full bg-card border rounded shadow">...</div>}
</div>

// GOOD: shadcn DropdownMenu
<DropdownMenu>
  <DropdownMenuTrigger asChild><Button>Menu</Button></DropdownMenuTrigger>
  <DropdownMenuContent>
    <DropdownMenuItem>Action</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

```tsx
// BAD: custom progress bar
<div className="h-2 bg-muted rounded-full">
  <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
</div>

// GOOD: shadcn Progress
<Progress value={pct} />
```
