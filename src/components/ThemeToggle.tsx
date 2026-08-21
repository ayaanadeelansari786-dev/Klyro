'use client';

import { useEffect, useState } from 'react';

export const THEME_KEY = 'klyro-theme';

/**
 * The script that runs before first paint.
 *
 * It exists because the alternative is a flash of the wrong theme: React
 * cannot stamp the root element until it has hydrated, and by then the browser
 * has already painted a dark page for someone who chose light. Stamping is
 * only needed when there *is* a choice — with nothing stored, the stylesheet's
 * own default and its `prefers-color-scheme` block are already correct, so the
 * script does nothing and the markup stays identical on the server and the
 * client.
 */
export const themeBootScript = `document.documentElement.classList.add('js');try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

type Theme = 'light' | 'dark';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export default function ThemeToggle() {
  /*
   * Undefined until mounted, and rendered as a fixed-size placeholder in the
   * meantime. The server has no way to know which theme this visitor is on, so
   * committing to one in the markup would either mismatch on hydration or lie
   * about what the button does.
   */
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      // Private browsing, or storage denied. The toggle still works for the
      // life of the page; only the memory of it is lost.
    }
    setTheme(stored === 'light' || stored === 'dark' ? stored : systemTheme());
  }, []);

  /*
   * Follow the OS while the visitor has not overridden it. Someone whose
   * machine switches at sunset should see Klyro switch too, right up until
   * they say otherwise — after which their choice holds.
   */
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(THEME_KEY);
      } catch {
        /* as above */
      }
      if (stored !== 'light' && stored !== 'dark') setTheme(systemTheme());
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* as above */
    }
  }

  if (theme === null) {
    // Same footprint as the real control, so the header does not reflow.
    return <span className="block h-[30px] w-[58px]" aria-hidden="true" />;
  }

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => choose(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="group inline-flex h-[30px] w-[58px] items-center rounded-full border border-line
        bg-raised px-1 transition-colors duration-200 hover:border-line-strong
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink"
    >
      <span
        className={`flex h-[22px] w-[22px] items-center justify-center rounded-full bg-seal
          text-seal-on transition-transform duration-300 ease-out ${
            theme === 'light' ? 'translate-x-[26px]' : 'translate-x-0'
          }`}
      >
        {/* Sun and moon are the convention, and a convention is worth more
            than a clever mark on a control this small. */}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          {theme === 'light' ? (
            <>
              <circle cx="8" cy="8" r="3.1" fill="currentColor" />
              <path
                d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13M12.95 12.95l-1.13-1.13M4.18 4.18L3.05 3.05"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </>
          ) : (
            <path
              d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z"
              fill="currentColor"
            />
          )}
        </svg>
      </span>
    </button>
  );
}
