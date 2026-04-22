import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Minus, Plus, Crosshair } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';

type LimitPriceInputProps = {
  value: number;
  onChange: (price: number) => void;
  tickSize: number;
  midpoint?: number;
  disabled?: boolean;
  className?: string;
};

export function LimitPriceInput({
  value,
  onChange,
  tickSize,
  midpoint,
  disabled = false,
  className,
}: LimitPriceInputProps) {
  const step = (dir: 1 | -1) => {
    const next = +(value + dir * tickSize).toFixed(4);
    if (next > 0) onChange(next);
  };

  const snapToMid = () => {
    if (midpoint != null) onChange(midpoint);
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8 shrink-0"
        disabled={disabled || value <= tickSize}
        onClick={() => step(-1)}
      >
        <Minus className="size-3.5" />
      </Button>

      <Input
        type="number"
        step={tickSize}
        min={tickSize}
        value={value.toFixed(2)}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v) && v > 0) onChange(+(v).toFixed(4));
        }}
        disabled={disabled}
        className="h-8 w-24 text-center font-mono tabular-nums text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />

      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8 shrink-0"
        disabled={disabled}
        onClick={() => step(1)}
      >
        <Plus className="size-3.5" />
      </Button>

      {midpoint != null && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              disabled={disabled}
              onClick={snapToMid}
            >
              <Crosshair className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Snap to midpoint ({formatCurrency(midpoint)})</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
