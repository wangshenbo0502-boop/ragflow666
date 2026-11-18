import { useEffect, type RefObject } from 'react';

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Track the page's own scroll viewport, rather than the fixed document. */
export function useRailMotion(pageRef: RefObject<HTMLElement>) {
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const stages = page.querySelectorAll<HTMLElement>('[data-rail-stage]');
    const diagrams = Array.from(
      page.querySelectorAll<HTMLElement>('[data-rail-diagram-stage]'),
      (stage) => ({
        stage,
        traces: Array.from(
          stage.querySelectorAll<SVGElement>('[data-rail-trace]'),
        ),
      }),
    );
    const entered = new IntersectionObserver(
      (entries) => {
        for (const { isIntersecting, target } of entries) {
          if (!isIntersecting) continue;
          target.setAttribute('data-rail-entered', '');
          entered.unobserve(target);
        }
      },
      { root: page, rootMargin: '0px 0px -6% 0px' },
    );
    stages.forEach((stage) => entered.observe(stage));
    let frame = 0;
    const update = () => {
      frame = 0;
      const viewport = page.getBoundingClientRect();
      const height = page.clientHeight;
      diagrams.forEach(({ stage, traces }) => {
        const top = stage.getBoundingClientRect().top - viewport.top;
        const progress = preference.matches
          ? 1
          : clamp((height * 0.96 - top) / (height * 0.6));
        stage.style.setProperty('--rail-diagram', String(progress));
        traces.forEach((trace) => {
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
    stages.forEach((stage) => observer.observe(stage));
    page.addEventListener('scroll', schedule, { passive: true });
    preference.addEventListener('change', schedule);
    window.addEventListener('resize', schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      entered.disconnect();
      observer.disconnect();
      page.removeEventListener('scroll', schedule);
      preference.removeEventListener('change', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [pageRef]);
}
