import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { BookOpen, House, Menu, MessagesSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Routes } from '@/routes';

const MenuItems = [
  { path: Routes.Root, name: '工作台', icon: House },
  { path: Routes.Datasets, name: '知识库', icon: BookOpen },
  {
    path: Routes.Chats,
    name: '铁路问答',
    icon: MessagesSquare,
    testId: 'nav-chat',
  },
];

function useActivePath() {
  const { pathname } = useLocation();
  if (
    pathname === Routes.Datasets ||
    pathname.startsWith(`${Routes.DatasetBase}/`)
  )
    return Routes.Datasets;
  if (pathname === Routes.Chats || pathname.startsWith(`${Routes.Chat}/`))
    return Routes.Chats;
  return pathname;
}

export function DesktopNavbar() {
  const activePath = useActivePath();
  return (
    <nav aria-label="主导航">
      <ul className="rail-nav">
        {MenuItems.map(({ path, name, icon: Icon, testId }) => (
          <li key={path}>
            <Link
              to={path}
              data-testid={testId}
              className={cn(
                'rail-nav-link',
                activePath === path && 'is-active',
              )}
              aria-current={activePath === path ? 'page' : undefined}
            >
              <Icon className="size-4" />
              <span>{name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function MobileNavbar({
  renderFooter,
}: {
  renderFooter?: (close: () => void) => React.ReactNode;
}) {
  const activePath = useActivePath();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="导航菜单">
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="flex w-[min(85vw,18rem)] flex-col gap-0 p-0"
      >
        <SheetTitle className="px-6 py-7 text-lg">轨知 RailMind</SheetTitle>
        <nav className="flex-1">
          {MenuItems.map(({ path, name, icon: Icon, testId }) => (
            <Link
              key={path}
              to={path}
              data-testid={testId}
              onClick={close}
              className={cn(
                'flex items-center gap-3 px-6 py-4 text-sm',
                activePath === path && 'bg-bg-card text-accent-primary',
              )}
              aria-current={activePath === path ? 'page' : undefined}
            >
              <Icon className="size-5" />
              {name}
            </Link>
          ))}
        </nav>
        {renderFooter?.(close)}
      </SheetContent>
    </Sheet>
  );
}

export default DesktopNavbar;
