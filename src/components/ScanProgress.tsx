'use client';

import { COLORS } from '@/lib/constants';
import { riskColorFor } from '@/lib/scoring';
import type { CategoryKey, ModuleStatus } from '@/lib/types';

const TONE_COLORS = {
  good: COLORS.good,
  warn: COLORS.warn,
  bad: COLORS.bad,
} as const;

export interface ProgressModule {
  key: CategoryKey;
  label: string;
  status: ModuleStatus;
  score?: number;
}

interface ScanProgressProps {
  domain: string;
  modules: ProgressModule[];
  elapsedSeconds: number;
  /** Set when a second domain is being assessed alongside this one. */
  contextDomain?: string | null;
}

/**
 * Every module is on screen from the first frame — the list never reorders or
 * grows, so the only thing that moves is state. That is what makes a wait feel
 * short.
 */
export default function ScanProgress({
  domain,
  modules,
  elapsedSeconds,
  contextDomain,
}: ScanProgressProps) {
  const done = modules.filter((m) => m.status === 'complete' || m.status === 'failed').length;
  const percent = modules.length ? (done / modules.length) * 100 : 0;

  return (
    <div className="mx-auto w-full max-w-3xl py-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <p className="micro">Assessing</p>
          <h1 className="mt-3 truncate font-mono text-[28px] leading-none tracking-tight text-tx sm:text-[34px]">
            {domain}
          </h1>
          <p className="mt-4 max-w-md text-[12.5px] leading-relaxed text-tx-2">
            Reading public exposure data across {modules.length} categories. Typically 15 to 30
            seconds, bounded by how fast the certificate transparency logs answer.
          </p>
        </div>

        <div className="flex items-end gap-8">
          <div>
            <div className="num text-[40px] font-semibold leading-none text-tx">
              {done}
              <span className="text-tx-3">/{modules.length}</span>
            </div>
            <div className="micro mt-2">complete</div>
          </div>
          <div>
            <div className="num text-[40px] font-semibold leading-none text-tx-2 tabular-nums">
              {elapsedSeconds}
              <span className="text-[20px] text-tx-3">s</span>
            </div>
            <div className="micro mt-2">elapsed</div>
          </div>
        </div>
      </div>

      <div className="mt-8 h-[3px] w-full bg-line">
        <div
          className="h-full bg-tx transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      <ul className="panel mt-6 overflow-hidden">
        {modules.map((module, i) => {
          const accent =
            module.status === 'complete' && module.score !== undefined
              ? TONE_COLORS[riskColorFor(module.score)]
              : undefined;

          return (
            <li
              key={module.key}
              className={`grid grid-cols-[26px_minmax(0,1fr)_96px_44px] items-center gap-4 border-t
                border-line px-5 py-3 transition-colors duration-200 sm:px-6 ${
                  i === 0 ? 'border-t-0' : ''
                } ${module.status === 'running' ? 'bg-raised' : ''}`}
            >
              <span className="font-mono text-[10.5px] text-tx-3 tabular-nums">
                {String(i + 1).padStart(2, '0')}
              </span>

              <span
                className={`truncate text-[13.5px] transition-colors duration-200 ${
                  module.status === 'pending'
                    ? 'text-tx-3'
                    : module.status === 'running'
                      ? 'text-tx'
                      : 'text-tx-2'
                }`}
              >
                {module.label}
              </span>

              <span className="relative block h-[6px] w-full bg-line">
                {module.status === 'complete' && module.score !== undefined && (
                  <span
                    className="absolute inset-y-0 left-0 transition-[width] duration-700 ease-out"
                    style={{ width: `${module.score}%`, background: accent }}
                  />
                )}
                {module.status === 'running' && (
                  <span className="absolute inset-0 animate-pulse bg-line-strong" />
                )}
                {module.status === 'failed' && (
                  <span className="absolute inset-y-0 left-0 w-full bg-risk-warn/25" />
                )}
              </span>

              <span className="text-right font-mono text-[12.5px] tabular-nums">
                {module.status === 'complete' && module.score !== undefined ? (
                  <span style={{ color: accent }}>{module.score}</span>
                ) : module.status === 'failed' ? (
                  <span className="text-risk-warn">n/a</span>
                ) : module.status === 'running' ? (
                  <span className="text-tx-2">···</span>
                ) : (
                  <span className="text-tx-3">—</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {/* The reader's own domain gets no module list of its own — this screen
          belongs to the domain they asked about. */}
      {contextDomain && (
        <div className="panel mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 sm:px-6">
          <span
            className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-tx-2"
            aria-hidden="true"
          />
          <p className="text-[12.5px] text-tx-2">
            Also assessing <span className="font-mono text-tx">{contextDomain}</span> for comparison,
            alongside this scan rather than after it.
          </p>
        </div>
      )}
    </div>
  );
}
