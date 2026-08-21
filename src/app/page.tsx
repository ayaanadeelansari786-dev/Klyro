import Link from 'next/link';

import { PageFooter, SiteHeader } from '@/components/Chrome';
import VaultDial from '@/components/VaultDial';
import Boundary from '@/components/home/Boundary';
import ClosingCTA from '@/components/home/ClosingCTA';
import FindingAnatomy from '@/components/home/FindingAnatomy';
import Hero from '@/components/home/Hero';
import HowItWorks from '@/components/home/HowItWorks';
import ScoreBands from '@/components/home/ScoreBands';
import SignalBand from '@/components/home/SignalBand';
import StickyBar from '@/components/home/StickyBar';

/**
 * The measure, shared by every section.
 *
 * `main` is no longer the thing that constrains width — the signal band runs
 * edge to edge and could not, while the width lived on a common ancestor. Each
 * section opts into the measure instead, which is also what keeps the sections
 * aligned with each other: they are all reading the same constant rather than
 * each carrying its own padding.
 */
const SHELL = 'mx-auto w-full max-w-[1180px] px-5 sm:px-8';

export default function HomePage() {
  return (
    <main className="pb-6">
      <div className={SHELL}>
        <StickyBar>
          <SiteHeader href={null}>
            <nav className="flex items-center gap-6">
              <Link
                href="/rankings"
                className="text-[12.5px] text-tx-2 transition-colors duration-150 hover:text-tx"
              >
                Benchmark dataset
              </Link>
              <span className="micro hidden sm:inline">External exposure assessment</span>
            </nav>
          </SiteHeader>
        </StickyBar>

        <Hero />
      </div>

      {/* Full bleed, and the only element on the page that is. It reads as the
          instrument's tape running past, which needs both edges of the screen
          to work — cropped to the measure it would just be a list. */}
      <div className="mt-14 sm:mt-20">
        <SignalBand />
      </div>

      <div className={SHELL}>
        <HowItWorks />
        <FindingAnatomy />

        {/* The dial, and the ledger it indexes. */}
        <VaultDial />

        <ScoreBands />
        <Boundary />
        <ClosingCTA />
        <PageFooter />
      </div>
    </main>
  );
}
