import { LucideMoon, LucideSun } from 'lucide-react';

import {
  useAnimatedThemeSwitch,
  useIsDarkTheme,
} from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import { ThemeEnum } from '@/constants/common';
import { cn } from '@/lib/utils';

export default function ThemeButton({ className }: { className?: string }) {
  const isDark = useIsDarkTheme();
  const setTheme = useAnimatedThemeSwitch();
  const label = isDark ? '切换浅色模式' : '切换深色模式';
  function toggleTheme() {
    setTheme(isDark ? ThemeEnum.Light : ThemeEnum.Dark);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('relative size-10 shrink-0 lg:size-8', className)}
      title={label}
      aria-label={label}
      onClick={toggleTheme}
    >
      {!isDark ? (
        <LucideSun className="size-5 lg:size-4" />
      ) : (
        <LucideMoon className="size-5 lg:size-4" />
      )}
    </Button>
  );
}
