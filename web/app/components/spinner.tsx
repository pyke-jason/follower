export function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
    </div>
  );
}
