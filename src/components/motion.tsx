'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The motion primitives the landing page is built from.
 *
 * Deliberately not a library. Everything here is one IntersectionObserver, one
 * pointermove handler and one scroll handler, all of them rAF-coalesced and
 * all of them yielding to `prefers-reduced-motion` — which is roughly the
 * subset of GSAP this page would actually have used, at none of the weight and
 * with no second animation runtime to reason about alongside React's.
 *
 * If scroll-*scrubbed* timelines are wanted later — an element whose progress
 * is bound to scroll position rather than merely triggered by it — that is the
 * point at which a real library earns its place, and ScrollTrigger is the one.
 */

/*
 * One observer for the whole document, not one per revealed element.
 *
 * There are around thirty revealed nodes on this page. Thirty observers is
 * thirty separate sets of intersection bookkeeping the browser runs on every
 * scroll; one observer with thirty targets is a single pass. Each target is
 * unobserved the moment it fires, because a reveal is a one-way door — a
 * section that has been read does not un-reveal when it leaves the viewport,
 * and re-animating on the way back up is what makes a page feel cheap.
 */
let sharedObserver: IntersectionObserver | null = null;
const pending = new WeakMap<Element, () => void>();

function observe(el: Element, onEnter: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onEnter();
    return () => {};
  }

  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const run = pending.get(entry.target);
          pending.delete(entry.target);
          sharedObserver?.unobserve(entry.target);
          run?.();
        }
      },
      // Fires a little before the element is fully in view, so the movement is
      // finishing as the reader arrives rather than starting.
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    );
  }

  pending.set(el, onEnter);
  sharedObserver.observe(el);

  return () => {
    pending.delete(el);
    sharedObserver?.unobserve(el);
  };
}

/**
 * Ref plus a flag, for callers that need the reveal on a semantic element.
 *
 * The flag is written as `data-reveal="in"` rather than as a class, because
 * the CSS gate for the whole mechanism is an attribute selector under `.js` —
 * see `globals.css`. With scripting off nothing here runs and nothing hides.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el, () => setShown(true));
  }, []);

  return { ref, shown };
}

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  /** Milliseconds. For ordering within a group, not for suspense. */
  delay?: number;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();

  return (
    <div
      ref={ref}
      data-reveal={shown ? 'in' : ''}
      style={delay ? ({ '--reveal-delay': `${delay}ms` } as React.CSSProperties) : undefined}
      className={className}
    >
      {children}
    </div>
  );
}

/**
 * A headline that arrives a word at a time.
 *
 * Split at render — the text is static, so there is none of the runtime
 * measuring a SplitText-style plugin does — and triggered on mount rather than
 * on scroll, because this is the first thing on the page and has no scroll to
 * wait for.
 *
 * The spaces are real text nodes *between* the spans, not inside them: a
 * trailing space inside an `inline-block` collapses, and the headline would
 * set as one unbroken word.
 */
export function SplitWords({
  text,
  className,
  stagger = 52,
  initialDelay = 90,
}: {
  text: string;
  className?: string;
  stagger?: number;
  initialDelay?: number;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // Two frames: one for the browser to paint the hidden state, one to change
    // it. Setting both in the same frame is not a transition, it is a jump.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, []);

  const words = text.split(' ');

  return (
    <span className={className}>
      {words.map((word, i) => (
        <span key={`${word}-${i}`}>
          <span
            data-reveal-word={shown ? 'in' : ''}
            style={{ '--reveal-delay': `${initialDelay + i * stagger}ms` } as React.CSSProperties}
          >
            {word}
          </span>
          {i < words.length - 1 ? ' ' : null}
        </span>
      ))}
    </span>
  );
}

/**
 * The specular highlight that follows the pointer across a glazed panel.
 *
 * Writes two custom properties and nothing else — no React state, so a pointer
 * crossing the scan form does not re-render the form on every sample. The rect
 * is cached and refreshed on enter, scroll and resize rather than measured per
 * event, because `getBoundingClientRect` inside `pointermove` is a forced
 * synchronous layout on the one surface the reader is actively using.
 */
export function useSheen<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let rect = el.getBoundingClientRect();
    let frame = 0;
    let x = 0;
    let y = 0;

    const remeasure = () => {
      rect = el.getBoundingClientRect();
    };

    const apply = () => {
      frame = 0;
      el.style.setProperty('--mx', `${x}px`);
      el.style.setProperty('--my', `${y}px`);
    };

    const onMove = (event: PointerEvent) => {
      x = event.clientX - rect.left;
      y = event.clientY - rect.top;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerenter', remeasure);
    window.addEventListener('scroll', remeasure, { passive: true });
    window.addEventListener('resize', remeasure);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerenter', remeasure);
      window.removeEventListener('scroll', remeasure);
      window.removeEventListener('resize', remeasure);
    };
  }, []);

  return ref;
}

/**
 * Depth by differential rate: an element that moves more slowly than the page.
 *
 * Written straight to the element's transform, not through state, for the same
 * reason as the sheen — a parallax that re-renders its subtree sixty times a
 * second is a parallax that drops frames. `rate` is the fraction of the page's
 * movement it gives up: 0.12 is a watermark drifting, 0.4 would be a separate
 * object flying past.
 */
export function useParallax<T extends HTMLElement>(rate = 0.12, spin = 0) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;

    const apply = () => {
      frame = 0;
      const offset = window.scrollY;
      el.style.transform =
        `translate3d(0, ${(-offset * rate).toFixed(2)}px, 0)` +
        (spin ? ` rotate(${(offset * spin).toFixed(3)}deg)` : '');
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
  }, [rate, spin]);

  return ref;
}
