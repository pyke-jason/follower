import { useState } from 'react';
import { CheckIcon, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type TraderComboboxProps = {
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
};

export function TraderCombobox({
  options,
  value,
  onChange,
  placeholder = 'Select traders...',
}: TraderComboboxProps) {
  const [open, setOpen] = useState(false);

  function toggleTrader(name: string) {
    onChange(value.includes(name)
      ? value.filter((trader) => trader !== name)
      : [...value, name]);
  }

  function renderSummary() {
    if (value.length === 0) return placeholder;
    if (value.length === options.length) return `All traders (${value.length})`;
    if (value.length === 1) return value[0];
    return `${value.length} traders selected`;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'h-9 w-full justify-between px-3 text-left font-normal shadow-xs',
            value.length === 0 && 'text-muted-foreground',
          )}
        >
          <span className="truncate pr-3">
            {renderSummary()}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search traders..." className="h-9" />
          <CommandList>
            <CommandEmpty>No traders found.</CommandEmpty>
            {value.length > 0 && (
              <>
                <CommandGroup>
                  <CommandItem onSelect={() => onChange([])} className="justify-center text-xs text-muted-foreground">
                    Clear traders
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup>
              {options.map((option) => {
                const isSelected = value.includes(option);
                return (
                  <CommandItem
                    key={option}
                    value={option}
                    onSelect={() => toggleTrader(option)}
                  >
                    <div className={cn(
                      'flex size-4 items-center justify-center rounded-sm border border-primary',
                      isSelected ? 'bg-primary text-primary-foreground' : 'opacity-50',
                    )}>
                      {isSelected && <CheckIcon className="size-3" />}
                    </div>
                    <span className="truncate">{option}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
