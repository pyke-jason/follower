'use client';

import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
export function TraderCombobox({
  existingTraders,
  authors,
}: {
  existingTraders: string[];
  authors: string[];
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [search, setSearch] = useState('');

  const suggestions = authors.filter(
    (t) => !existingTraders.includes(t)
  );

  const searchTrimmed = search.trim();
  const exactMatch = suggestions.some(
    (t) => t.toLowerCase() === searchTrimmed.toLowerCase()
  );
  const showCustom = searchTrimmed.length > 0 && !exactMatch;

  function select(name: string) {
    setValue(name);
    setSearch('');
    setOpen(false);
  }

  return (
    <>
      <input type="hidden" name="name" value={value} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-8 w-[180px] justify-between text-sm font-normal"
          >
            {value || (
              <span className="text-muted-foreground">Select trader…</span>
            )}
            <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[180px] p-0">
          <Command>
            <CommandInput
              placeholder="Search…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>No known traders.</CommandEmpty>
              <CommandGroup>
                {suggestions.map((trader) => (
                  <CommandItem
                    key={trader}
                    value={trader}
                    onSelect={() => select(trader)}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-3 w-3',
                        value === trader ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    {trader}
                  </CommandItem>
                ))}
                {showCustom && (
                  <CommandItem
                    value={`__custom:${searchTrimmed}`}
                    onSelect={() => select(searchTrimmed)}
                  >
                    Add &ldquo;{searchTrimmed}&rdquo;
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
