import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isJsonLike(str: string): boolean {
  const trimmed = str.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function isLongOrJson(value: unknown): boolean {
  const str = String(value);
  return str.length >= 200 || isJsonLike(str);
}

// ── CellEditor ───────────────────────────────────────────────────────────────

interface CellEditorProps {
  table: string;
  rowId: string;
  column: string;
  value: unknown;
  onClose: () => void;
  onSaved: () => void;
}

export function CellEditor({ table, rowId, column, value, onClose, onSaved }: CellEditorProps) {
  const strValue = value === null || value === undefined ? '' : String(value);
  const useLongEditor = isLongOrJson(strValue);
  const [draft, setDraft] = useState(strValue);
  const inputRef = useRef<HTMLInputElement>(null);

  const mutation = useApiMutation<{ column: string; value: string | number | null }>(
    'PATCH',
    `/web/db/tables/${table}/${rowId}`,
    {
      onSuccess: () => {
        toast.success('Cell updated');
        onSaved();
        onClose();
      },
      onError: (err) => {
        toast.error(`Failed to update: ${err.message}`);
      },
    },
  );

  useEffect(() => {
    if (!useLongEditor) {
      // Focus inline input after mount
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [useLongEditor]);

  function save() {
    // Coerce numeric strings back to numbers if original value was a number
    const coerced: string | number | null =
      typeof value === 'number' && draft !== '' ? Number(draft) : draft === '' ? null : draft;
    mutation.mutate({ column, value: coerced });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  }

  // ── Short inline editor ──────────────────────────────────────────────────

  if (!useLongEditor) {
    return (
      <div className="flex items-center gap-1" onKeyDown={handleKeyDown}>
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-7 text-xs"
          disabled={mutation.isPending}
        />
        <Button size="sm" className="h-7 text-xs" onClick={save} disabled={mutation.isPending}>
          Save
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>
          Cancel
        </Button>
      </div>
    );
  }

  // ── Long / JSON Dialog editor ────────────────────────────────────────────

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Edit <span className="font-mono text-sm">{column}</span>
          </DialogTitle>
        </DialogHeader>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          className="font-mono text-xs min-h-[200px]"
          disabled={mutation.isPending}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={mutation.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
