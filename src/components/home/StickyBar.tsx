'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The header, floating.
 *
 * It is transparent until something has scrolled under it, at which point it
 * glazes — which is the only honest use of a frosted bar. A header that is
 * frosted from the first paint is frosting a background that is already its
 * own colour, and all it achieves is a seam across the top of the hero.
 *
 * The threshold is read through an rAF-coalesced scroll listener rather than a
 * sentinel element and an observer, because at 8px the sentinel would sit
 * inside the header's own sticky box and never report cleanly.
 */
export default function StickyBar({ children }: { children: React.ReactNode }) {
  const [lifted, setLifted] = useState(false);
  const frame = useRef(0);

  useEffect(() => {
    const read = () => {
      frame.current = 0;
      setLifted(window.scrollY > 8);
    };

    const onScroll = () => {
      if (!frame.current) frame.current = requestAnimationFrame(read);
    };

    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <div className="sticky top-0 z-40 pt-3 sm:pt-4">
      <div data-lifted={lifted} className="topbar px-4 py-2.5 sm:px-6 sm:py-3">
        {children}
      </div>
    </div>
  );
}
