import { getAuthorBgColor, getAuthorInitials } from '@/lib/author-colors';

export function AuthorAvatar({ name }: { name: string }) {
  return (
    <div
      className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white"
      style={{ backgroundColor: getAuthorBgColor(name) }}
    >
      {getAuthorInitials(name)}
    </div>
  );
}
