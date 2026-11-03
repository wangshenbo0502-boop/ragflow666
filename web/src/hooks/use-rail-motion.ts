import { useEffect, type RefObject } from 'react';

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Track the page's own scroll viewport, rather than the fixed document. */
export function useRailMotion(pageRef: RefObject<HTMLElement>) {
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const update = () => {
      frame = 0;
      const viewport = page.getBoundingClientRect();
      const height = page.clientHeight;
      page.style.setProperty('--rail-viewport', `${height}px`);
      page
        .querySelectorAll<HTMLElement>('[data-rail-reveal]')
        .forEach((node) => {
          const top = node.getBoundingClientRect().top - viewport.top;
          const progress = preference.matches
            ? 1
            : clamp((height * 0.97 - top) / (height * 0.24));
          node.style.setProperty('--rail-reveal', String(progress));
        });
      page
        .querySelectorAll<HTMLElement>('[data-rail-stage]')
        .forEach((stage) => {
          const top = stage.getBoundingClientRect().top - viewport.top;
          const progress = preference.matches
            ? 1
            : clamp((height * 0.85 - top) / (height * 0.65));
          stage.style.setProperty('--rail-progress', String(progress));
          const words = stage.querySelectorAll<HTMLElement>('[data-rail-word]');
          words.forEach((word, index) => {
            const clarity = preference.matches
              ? 1
              : clamp(progress * 2 - index / words.length);
            word.style.setProperty('--rail-clarity', String(clarity));
          });
        });
      page
        .querySelectorAll<HTMLElement>('[data-rail-diagram-stage]')
        .forEach((stage) => {
          const bounds = stage.getBoundingClientRect();
          const top = bounds.top - viewport.top;
          const scene = stage.querySelector<HTMLElement>(
            '.rail-capability-scene',
          );
          const travel = bounds.height - (scene?.offsetHeight ?? height);
          const progress = preference.matches
            ? 1
            : travel > 1
              ? clamp(-top / travel)
              : clamp((height * 0.85 - top) / (height * 0.95));
          stage.style.setProperty('--rail-diagram', String(progress));
          stage
            .querySelectorAll<SVGElement>('[data-rail-trace]')
            .forEach((trace) => {
              const start = Number(trace.dataset.traceStart);
              const end = Number(trace.dataset.traceEnd);
              trace.style.setProperty(
                '--rail-trace',
                String(clamp((progress - start) / (end - start))),
              );
            });
        });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(page);
    page.addEventListener('scroll', schedule, { passive: true });
    preference.addEventListener('change', schedule);
    window.addEventListener('resize', schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      page.removeEventListener('scroll', schedule);
      preference.removeEventListener('change', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [pageRef]);
}
