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
            {/*
             * The decorative "External exposure assessment" label that used to
             * sit here is gone: the header carries the account control now,
             * and the hero states the same thing forty pixels below.
             *
             * The sign-in and create-account links are no longer written here
             * either. They live in `AccountMenu`, inside `SiteHeader`, which
             * renders them only when nobody is signed in — a header that
             * offered "Create account" to somebody already holding one was
             * the thing worth fixing.
             *
             * Nor is the link to the benchmark dataset. It used to be a
             * one-item `<nav>` here, which meant the dataset was reachable
             * from this page and from nowhere else; it is in the shared
             * navigation now, on every page.
             */}
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
