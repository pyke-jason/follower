/* shadcn/ui primitives hand-ported — same source as shadcn-ui/ui.
   Uses Tailwind classes; assumes CSS vars from shadcn globals.css.
   Exports: cn, Card, CardHeader, CardTitle, CardDescription, CardContent,
   CardFooter, Badge, Button, Separator, ScrollArea, Tabs, TabsList,
   TabsTrigger, TabsContent. */

const cn = (...classes) => classes.filter(Boolean).join(' ');

// ── Card ──────────────────────────────────────────────────────
const Card = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('rounded-lg border border-border bg-card text-card-foreground shadow-sm', className)} {...props} />
));
const CardHeader = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex flex-col space-y-1.5 p-4', className)} {...props} />
));
const CardTitle = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm font-semibold leading-none tracking-tight', className)} {...props} />
));
const CardDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-xs text-muted-foreground', className)} {...props} />
));
const CardContent = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('p-4 pt-0', className)} {...props} />
));
const CardFooter = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex items-center p-4 pt-0', className)} {...props} />
));

// ── Badge ─────────────────────────────────────────────────────
function Badge({ className, variant = 'default', ...props }) {
  const variants = {
    default: 'bg-primary text-primary-foreground border-transparent',
    secondary: 'bg-secondary text-secondary-foreground border-transparent',
    destructive: 'bg-destructive text-destructive-foreground border-transparent',
    outline: 'text-foreground',
    success: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    warn: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    danger: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    info: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  };
  return <div className={cn('inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase', variants[variant], className)} {...props} />;
}

// ── Button ────────────────────────────────────────────────────
function Button({ className, variant = 'default', size = 'default', ...props }) {
  const variants = {
    default: 'bg-primary text-primary-foreground hover:bg-primary/90',
    destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
    secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
    ghost: 'hover:bg-accent hover:text-accent-foreground',
    link: 'text-primary underline-offset-4 hover:underline',
  };
  const sizes = {
    default: 'h-9 px-4 py-2',
    sm: 'h-8 rounded px-3 text-xs',
    xs: 'h-7 rounded px-2 text-xs',
    lg: 'h-10 rounded px-8',
    icon: 'h-9 w-9',
  };
  return <button className={cn('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50', variants[variant], sizes[size], className)} {...props} />;
}

// ── Separator ─────────────────────────────────────────────────
function Separator({ className, orientation = 'horizontal', ...props }) {
  return <div className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'w-px h-full', className)} {...props} />;
}

// ── Tabs (lightweight, no Radix) ──────────────────────────────
const TabsContext = React.createContext(null);
function Tabs({ defaultValue, value: controlledValue, onValueChange, className, children }) {
  const [internalValue, setInternalValue] = React.useState(defaultValue);
  const value = controlledValue !== undefined ? controlledValue : internalValue;
  const setValue = (v) => { setInternalValue(v); onValueChange?.(v); };
  return (
    <TabsContext.Provider value={{ value, setValue }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}
function TabsList({ className, ...props }) {
  return <div className={cn('inline-flex h-9 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground', className)} {...props} />;
}
function TabsTrigger({ value, className, ...props }) {
  const ctx = React.useContext(TabsContext);
  const active = ctx.value === value;
  return (
    <button
      onClick={() => ctx.setValue(value)}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1 text-xs font-medium transition-all',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}
function TabsContent({ value, className, ...props }) {
  const ctx = React.useContext(TabsContext);
  if (ctx.value !== value) return null;
  return <div className={cn('mt-2', className)} {...props} />;
}

// ── Table (shadcn Table) ──────────────────────────────────────
const Table = React.forwardRef(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto"><table ref={ref} className={cn('w-full caption-bottom text-xs', className)} {...props} /></div>
));
const TableHeader = React.forwardRef(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} />
));
const TableBody = React.forwardRef(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
));
const TableRow = React.forwardRef(({ className, ...props }, ref) => (
  <tr ref={ref} className={cn('border-b border-border/50 transition-colors hover:bg-muted/50', className)} {...props} />
));
const TableHead = React.forwardRef(({ className, ...props }, ref) => (
  <th ref={ref} className={cn('h-8 px-3 text-left align-middle text-[10px] font-medium uppercase tracking-wider text-muted-foreground', className)} {...props} />
));
const TableCell = React.forwardRef(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-3 py-2 align-middle', className)} {...props} />
));

Object.assign(window, {
  cn, Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
  Badge, Button, Separator,
  Tabs, TabsList, TabsTrigger, TabsContent,
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
});
