import type { CuratedOwnership } from '../intel/ownership';
import type { Industry, Region } from '../constants';

/**
 * Curated benchmark dataset.
 *
 * Ownership recorded here is a *curated fact with a named source*, not a
 * guess. Where a relationship is well established and publicly documented it
 * is stated; where it is not, `ownership` is left absent and the resolver
 * falls back to GLEIF and Wikidata, which report their own confidence.
 *
 * Entries marked `isParentEntity` exist so a subsidiary's parent can be
 * scanned and compared. They are still real vendors in their own right.
 */

export interface VendorSeed {
  domain: string;
  displayName: string;
  industry: Industry;
  region: Region;
  ownership?: CuratedOwnership;
  /** Included primarily so a subsidiary has a parent to be measured against. */
  isParentEntity?: boolean;
}

const WIKI = (page: string) => `https://en.wikipedia.org/wiki/${page}`;

export const VENDOR_SEEDS: VendorSeed[] = [
  /* ---------------- Banking & Finance ---------------- */
  { domain: 'emiratesnbd.com', displayName: 'Emirates NBD', industry: 'Banking & Finance', region: 'UAE',
    ownership: { legalName: 'Emirates NBD Bank PJSC', ownershipType: 'independent', hqCountry: 'AE' } },
  { domain: 'bankfab.com', displayName: 'First Abu Dhabi Bank', industry: 'Banking & Finance', region: 'UAE',
    ownership: { legalName: 'First Abu Dhabi Bank PJSC', ownershipType: 'independent', hqCountry: 'AE' } },
  { domain: 'adcb.com', displayName: 'Abu Dhabi Commercial Bank', industry: 'Banking & Finance', region: 'UAE',
    ownership: { legalName: 'Abu Dhabi Commercial Bank PJSC', ownershipType: 'independent', hqCountry: 'AE' } },
  { domain: 'mashreq.com', displayName: 'Mashreq Bank', industry: 'Banking & Finance', region: 'UAE' },
  { domain: 'alrajhibank.com.sa', displayName: 'Al Rajhi Bank', industry: 'Banking & Finance', region: 'Saudi Arabia' },
  { domain: 'sab.com', displayName: 'Saudi Awwal Bank', industry: 'Banking & Finance', region: 'Saudi Arabia',
    ownership: { ownershipType: 'subsidiary', parentName: 'HSBC Holdings', parentDomain: 'hsbc.com',
      source: 'HSBC holds a significant minority stake following the SABB/Alawwal merger', sourceUrl: WIKI('Saudi_Awwal_Bank') } },
  { domain: 'monzo.com', displayName: 'Monzo', industry: 'Banking & Finance', region: 'Global',
    ownership: { legalName: 'Monzo Bank Limited', ownershipType: 'independent', hqCountry: 'GB' } },
  { domain: 'revolut.com', displayName: 'Revolut', industry: 'Banking & Finance', region: 'Global' },
  { domain: 'wise.com', displayName: 'Wise', industry: 'Banking & Finance', region: 'Global' },
  { domain: 'stripe.com', displayName: 'Stripe', industry: 'Banking & Finance', region: 'Global' },
  { domain: 'adyen.com', displayName: 'Adyen', industry: 'Banking & Finance', region: 'Global' },
  { domain: 'venmo.com', displayName: 'Venmo', industry: 'Banking & Finance', region: 'Global',
    ownership: { ownershipType: 'subsidiary', parentName: 'PayPal', parentDomain: 'paypal.com',
      source: 'PayPal acquired Braintree, Venmo\'s owner, in 2013', sourceUrl: WIKI('Venmo') } },
  { domain: 'paypal.com', displayName: 'PayPal', industry: 'Banking & Finance', region: 'Global', isParentEntity: true,
    ownership: { legalName: 'PayPal Holdings, Inc.', ownershipType: 'independent', hqCountry: 'US' } },
  { domain: 'hsbc.com', displayName: 'HSBC', industry: 'Banking & Finance', region: 'Global', isParentEntity: true },

  /* ---------------- Insurance ---------------- */
  { domain: 'orientinsurance.com', displayName: 'Orient Insurance', industry: 'Insurance', region: 'UAE' },
  { domain: 'sukoon.com', displayName: 'Sukoon Insurance', industry: 'Insurance', region: 'UAE' },
  { domain: 'tawuniya.com', displayName: 'Tawuniya', industry: 'Insurance', region: 'Saudi Arabia' },
  { domain: 'bupa.com.sa', displayName: 'Bupa Arabia', industry: 'Insurance', region: 'Saudi Arabia',
    ownership: { ownershipType: 'joint_venture', parentName: 'Bupa', parentDomain: 'bupa.com',
      source: 'Bupa holds a major stake in the Saudi joint venture', sourceUrl: WIKI('Bupa_Arabia') } },
  { domain: 'axa.com', displayName: 'AXA', industry: 'Insurance', region: 'Global' },
  { domain: 'allianz.com', displayName: 'Allianz', industry: 'Insurance', region: 'Global' },
  { domain: 'lemonade.com', displayName: 'Lemonade', industry: 'Insurance', region: 'Global' },
  { domain: 'bupa.com', displayName: 'Bupa', industry: 'Insurance', region: 'Global', isParentEntity: true },

  /* ---------------- Real Estate ---------------- */
  { domain: 'emaar.com', displayName: 'Emaar Properties', industry: 'Real Estate', region: 'UAE' },
  { domain: 'damacproperties.com', displayName: 'DAMAC Properties', industry: 'Real Estate', region: 'UAE' },
  { domain: 'aldar.com', displayName: 'Aldar Properties', industry: 'Real Estate', region: 'UAE' },
  { domain: 'nakheel.com', displayName: 'Nakheel', industry: 'Real Estate', region: 'UAE' },
  { domain: 'bayut.com', displayName: 'Bayut', industry: 'Real Estate', region: 'UAE',
    ownership: { ownershipType: 'subsidiary', parentName: 'Dubizzle Group', parentDomain: 'dubizzle.com',
      source: 'Bayut and Dubizzle operate under the same group', sourceUrl: WIKI('Dubizzle') } },
  { domain: 'propertyfinder.ae', displayName: 'Property Finder', industry: 'Real Estate', region: 'UAE' },
  { domain: 'roshn.sa', displayName: 'ROSHN', industry: 'Real Estate', region: 'Saudi Arabia',
    ownership: { ownershipType: 'subsidiary', parentName: 'Public Investment Fund', parentDomain: 'pif.gov.sa',
      source: 'ROSHN is a PIF-owned giga-project developer', sourceUrl: WIKI('Roshn') } },
  { domain: 'zillow.com', displayName: 'Zillow', industry: 'Real Estate', region: 'Global' },

  /* ---------------- Retail & E-commerce ---------------- */
  { domain: 'noon.com', displayName: 'Noon', industry: 'Retail & E-commerce', region: 'UAE' },
  { domain: 'namshi.com', displayName: 'Namshi', industry: 'Retail & E-commerce', region: 'UAE',
    ownership: { ownershipType: 'acquired', parentName: 'Noon', parentDomain: 'noon.com',
      source: 'Noon acquired Namshi from Emaar in 2022', sourceUrl: WIKI('Namshi') } },
  { domain: 'amazon.ae', displayName: 'Amazon UAE', industry: 'Retail & E-commerce', region: 'UAE',
    ownership: { ownershipType: 'subsidiary', parentName: 'Amazon', parentDomain: 'amazon.com',
      source: 'Amazon acquired Souq.com in 2017 and rebranded it', sourceUrl: WIKI('Souq.com') } },
  { domain: 'carrefouruae.com', displayName: 'Carrefour UAE', industry: 'Retail & E-commerce', region: 'UAE',
    ownership: { ownershipType: 'joint_venture', parentName: 'Majid Al Futtaim', parentDomain: 'majidalfuttaim.com',
      source: 'Majid Al Futtaim operates Carrefour under franchise across the region', sourceUrl: WIKI('Majid_Al_Futtaim') } },
  { domain: 'majidalfuttaim.com', displayName: 'Majid Al Futtaim', industry: 'Retail & E-commerce', region: 'UAE', isParentEntity: true },
  { domain: 'landmarkgroup.com', displayName: 'Landmark Group', industry: 'Retail & E-commerce', region: 'UAE' },
  { domain: 'jarir.com', displayName: 'Jarir Bookstore', industry: 'Retail & E-commerce', region: 'Saudi Arabia' },
  { domain: 'shopify.com', displayName: 'Shopify', industry: 'Retail & E-commerce', region: 'Global' },
  { domain: 'amazon.com', displayName: 'Amazon', industry: 'Retail & E-commerce', region: 'Global', isParentEntity: true },

  /* ---------------- Healthcare ---------------- */
  { domain: 'clevelandclinicabudhabi.ae', displayName: 'Cleveland Clinic Abu Dhabi', industry: 'Healthcare', region: 'UAE',
    ownership: { ownershipType: 'subsidiary', parentName: 'Mubadala', parentDomain: 'mubadala.com',
      source: 'Operated by Cleveland Clinic under a Mubadala-owned entity', sourceUrl: WIKI('Cleveland_Clinic_Abu_Dhabi') } },
  { domain: 'nmc.ae', displayName: 'NMC Healthcare', industry: 'Healthcare', region: 'UAE' },
  { domain: 'mediclinic.ae', displayName: 'Mediclinic Middle East', industry: 'Healthcare', region: 'UAE',
    ownership: { ownershipType: 'subsidiary', parentName: 'Mediclinic International', parentDomain: 'mediclinic.com',
      source: 'Regional arm of Mediclinic International', sourceUrl: WIKI('Mediclinic_International') } },
  { domain: 'aster.ae', displayName: 'Aster DM Healthcare', industry: 'Healthcare', region: 'UAE' },
  { domain: 'drsulaimanalhabib.com', displayName: 'Dr. Sulaiman Al Habib', industry: 'Healthcare', region: 'Saudi Arabia' },
  { domain: 'mayoclinic.org', displayName: 'Mayo Clinic', industry: 'Healthcare', region: 'Global' },
  { domain: 'teladochealth.com', displayName: 'Teladoc Health', industry: 'Healthcare', region: 'Global' },

  /* ---------------- Education ---------------- */
  { domain: 'ku.ac.ae', displayName: 'Khalifa University', industry: 'Education', region: 'UAE' },
  { domain: 'aus.edu', displayName: 'American University of Sharjah', industry: 'Education', region: 'UAE' },
  { domain: 'uaeu.ac.ae', displayName: 'United Arab Emirates University', industry: 'Education', region: 'UAE' },
  { domain: 'kaust.edu.sa', displayName: 'KAUST', industry: 'Education', region: 'Saudi Arabia' },
  { domain: 'ksu.edu.sa', displayName: 'King Saud University', industry: 'Education', region: 'Saudi Arabia' },
  { domain: 'coursera.org', displayName: 'Coursera', industry: 'Education', region: 'Global' },
  { domain: 'udemy.com', displayName: 'Udemy', industry: 'Education', region: 'Global' },

  /* ---------------- Government ---------------- */
  { domain: 'u.ae', displayName: 'UAE Government Portal', industry: 'Government', region: 'UAE' },
  { domain: 'dubai.ae', displayName: 'Dubai Government', industry: 'Government', region: 'UAE' },
  { domain: 'mohre.gov.ae', displayName: 'UAE Ministry of Human Resources', industry: 'Government', region: 'UAE' },
  { domain: 'tdra.gov.ae', displayName: 'UAE Telecom & Digital Regulatory Authority', industry: 'Government', region: 'UAE' },
  { domain: 'my.gov.sa', displayName: 'Saudi National Portal', industry: 'Government', region: 'Saudi Arabia' },
  { domain: 'gov.uk', displayName: 'UK Government', industry: 'Government', region: 'Global' },
  { domain: 'usa.gov', displayName: 'US Government Portal', industry: 'Government', region: 'Global' },

  /* ---------------- Telecom ---------------- */
  { domain: 'etisalat.ae', displayName: 'e& (Etisalat UAE)', industry: 'Telecom', region: 'UAE',
    ownership: { ownershipType: 'subsidiary', parentName: 'e& (Emirates Telecommunications Group)', parentDomain: 'eand.com',
      source: 'Etisalat UAE operates under the e& group brand', sourceUrl: WIKI('E%26') } },
  { domain: 'eand.com', displayName: 'e& Group', industry: 'Telecom', region: 'UAE', isParentEntity: true },
  { domain: 'du.ae', displayName: 'du (EITC)', industry: 'Telecom', region: 'UAE' },
  { domain: 'stc.com.sa', displayName: 'stc', industry: 'Telecom', region: 'Saudi Arabia' },
  { domain: 'mobily.com.sa', displayName: 'Mobily', industry: 'Telecom', region: 'Saudi Arabia' },
  { domain: 'ooredoo.qa', displayName: 'Ooredoo', industry: 'Telecom', region: 'GCC' },
  { domain: 'vodafone.com', displayName: 'Vodafone', industry: 'Telecom', region: 'Global' },

  /* ---------------- Oil & Gas ---------------- */
  { domain: 'adnoc.ae', displayName: 'ADNOC', industry: 'Oil & Gas', region: 'UAE' },
  { domain: 'aramco.com', displayName: 'Saudi Aramco', industry: 'Oil & Gas', region: 'Saudi Arabia', isParentEntity: true },
  { domain: 'sabic.com', displayName: 'SABIC', industry: 'Oil & Gas', region: 'Saudi Arabia',
    ownership: { ownershipType: 'subsidiary', parentName: 'Saudi Aramco', parentDomain: 'aramco.com',
      source: 'Aramco acquired a 70% stake in SABIC from PIF in 2020', sourceUrl: WIKI('SABIC') } },
  { domain: 'qatarenergy.qa', displayName: 'QatarEnergy', industry: 'Oil & Gas', region: 'GCC' },
  { domain: 'kpc.com.kw', displayName: 'Kuwait Petroleum Corporation', industry: 'Oil & Gas', region: 'GCC' },
  { domain: 'shell.com', displayName: 'Shell', industry: 'Oil & Gas', region: 'Global' },
  { domain: 'bp.com', displayName: 'BP', industry: 'Oil & Gas', region: 'Global' },

  /* ---------------- Logistics & Transport ---------------- */
  { domain: 'dpworld.com', displayName: 'DP World', industry: 'Logistics & Transport', region: 'UAE' },
  { domain: 'aramex.com', displayName: 'Aramex', industry: 'Logistics & Transport', region: 'UAE' },
  { domain: 'emirates.com', displayName: 'Emirates Airline', industry: 'Logistics & Transport', region: 'UAE' },
  { domain: 'etihad.com', displayName: 'Etihad Airways', industry: 'Logistics & Transport', region: 'UAE' },
  { domain: 'flydubai.com', displayName: 'flydubai', industry: 'Logistics & Transport', region: 'UAE' },
  { domain: 'careem.com', displayName: 'Careem', industry: 'Logistics & Transport', region: 'UAE',
    ownership: { ownershipType: 'acquired', parentName: 'Uber', parentDomain: 'uber.com',
      source: 'Uber acquired Careem in a deal completed in 2020', sourceUrl: WIKI('Careem') } },
  { domain: 'uber.com', displayName: 'Uber', industry: 'Logistics & Transport', region: 'Global', isParentEntity: true },
  { domain: 'maersk.com', displayName: 'Maersk', industry: 'Logistics & Transport', region: 'Global' },

  /* ---------------- Hospitality & Tourism ---------------- */
  { domain: 'jumeirah.com', displayName: 'Jumeirah Group', industry: 'Hospitality & Tourism', region: 'UAE',
    ownership: { ownershipType: 'subsidiary', parentName: 'Dubai Holding', parentDomain: 'dubaiholding.com',
      source: 'Jumeirah Group is part of Dubai Holding', sourceUrl: WIKI('Jumeirah') } },
  { domain: 'dubaiholding.com', displayName: 'Dubai Holding', industry: 'Hospitality & Tourism', region: 'UAE', isParentEntity: true },
  { domain: 'rotana.com', displayName: 'Rotana Hotels', industry: 'Hospitality & Tourism', region: 'UAE' },
  { domain: 'atlantis.com', displayName: 'Atlantis Resorts', industry: 'Hospitality & Tourism', region: 'UAE' },
  { domain: 'visitsaudi.com', displayName: 'Visit Saudi', industry: 'Hospitality & Tourism', region: 'Saudi Arabia' },
  { domain: 'booking.com', displayName: 'Booking.com', industry: 'Hospitality & Tourism', region: 'Global',
    ownership: { ownershipType: 'subsidiary', parentName: 'Booking Holdings', parentDomain: 'bookingholdings.com',
      source: 'Booking.com is the principal brand of Booking Holdings', sourceUrl: WIKI('Booking_Holdings') } },
  { domain: 'marriott.com', displayName: 'Marriott International', industry: 'Hospitality & Tourism', region: 'Global' },

  /* ---------------- Technology ---------------- */
  { domain: 'okta.com', displayName: 'Okta', industry: 'Technology', region: 'Global', isParentEntity: true,
    ownership: { legalName: 'OKTA, INC.', ownershipType: 'independent', hqCountry: 'US' } },
  { domain: 'auth0.com', displayName: 'Auth0', industry: 'Technology', region: 'Global',
    ownership: { ownershipType: 'acquired', parentName: 'Okta', parentDomain: 'okta.com',
      source: 'Okta acquired Auth0 in 2021', sourceUrl: WIKI('Auth0') } },
  { domain: 'github.com', displayName: 'GitHub', industry: 'Technology', region: 'Global',
    ownership: { legalName: 'GITHUB INC', ownershipType: 'acquired', parentName: 'Microsoft', parentDomain: 'microsoft.com',
      source: 'Microsoft acquired GitHub in 2018', sourceUrl: WIKI('GitHub') } },
  { domain: 'microsoft.com', displayName: 'Microsoft', industry: 'Technology', region: 'Global', isParentEntity: true,
    ownership: { legalName: 'MICROSOFT CORPORATION', ownershipType: 'independent', hqCountry: 'US' } },
  { domain: 'redhat.com', displayName: 'Red Hat', industry: 'Technology', region: 'Global',
    ownership: { ownershipType: 'acquired', parentName: 'IBM', parentDomain: 'ibm.com',
      source: 'IBM acquired Red Hat in 2019', sourceUrl: WIKI('Red_Hat') } },
  { domain: 'ibm.com', displayName: 'IBM', industry: 'Technology', region: 'Global', isParentEntity: true },
  { domain: 'vmware.com', displayName: 'VMware', industry: 'Technology', region: 'Global',
    ownership: { ownershipType: 'acquired', parentName: 'Broadcom', parentDomain: 'broadcom.com',
      source: 'Broadcom completed its acquisition of VMware in 2023', sourceUrl: WIKI('VMware') } },
  { domain: 'broadcom.com', displayName: 'Broadcom', industry: 'Technology', region: 'Global', isParentEntity: true },
  { domain: 'slack.com', displayName: 'Slack', industry: 'Technology', region: 'Global',
    ownership: { ownershipType: 'acquired', parentName: 'Salesforce', parentDomain: 'salesforce.com',
      source: 'Salesforce acquired Slack in 2021', sourceUrl: WIKI('Slack_Technologies') } },
  { domain: 'salesforce.com', displayName: 'Salesforce', industry: 'Technology', region: 'Global', isParentEntity: true },
  { domain: 'cloudflare.com', displayName: 'Cloudflare', industry: 'Technology', region: 'Global' },
  { domain: 'atlassian.com', displayName: 'Atlassian', industry: 'Technology', region: 'Global' },
  { domain: 'careem.tech', displayName: 'Careem Engineering', industry: 'Technology', region: 'UAE',
    ownership: { ownershipType: 'division', parentName: 'Careem', parentDomain: 'careem.com',
      source: 'Engineering domain operated by Careem' } },
  { domain: 'g42.ai', displayName: 'G42', industry: 'Technology', region: 'UAE' },

  /* ---------------- Construction ---------------- */
  { domain: 'arabtec.ae', displayName: 'Arabtec', industry: 'Construction', region: 'UAE' },
  { domain: 'alec.ae', displayName: 'ALEC Engineering', industry: 'Construction', region: 'UAE' },
  { domain: 'binladingroup.com', displayName: 'Saudi Binladin Group', industry: 'Construction', region: 'Saudi Arabia' },
  { domain: 'neom.com', displayName: 'NEOM', industry: 'Construction', region: 'Saudi Arabia',
    ownership: { ownershipType: 'subsidiary', parentName: 'Public Investment Fund', parentDomain: 'pif.gov.sa',
      source: 'NEOM is wholly owned by the Public Investment Fund', sourceUrl: WIKI('Neom') } },
  { domain: 'pif.gov.sa', displayName: 'Public Investment Fund', industry: 'Government', region: 'Saudi Arabia', isParentEntity: true },
  { domain: 'bechtel.com', displayName: 'Bechtel', industry: 'Construction', region: 'Global' },
  { domain: 'vinci.com', displayName: 'VINCI', industry: 'Construction', region: 'Global' },

  /* ---------------- Manufacturing ---------------- */
  { domain: 'bosch.com', displayName: 'Bosch', industry: 'Manufacturing', region: 'Global', isParentEntity: true,
    ownership: { legalName: 'Robert Bosch GmbH', hqCountry: 'DE' } },
  { domain: 'bosch-security.com', displayName: 'Bosch Building Technologies', industry: 'Manufacturing', region: 'Global',
    ownership: { ownershipType: 'division', parentName: 'Bosch', parentDomain: 'bosch.com',
      source: 'Bosch Building Technologies is a Bosch division', sourceUrl: WIKI('Robert_Bosch_GmbH') } },
  { domain: 'siemens.com', displayName: 'Siemens', industry: 'Manufacturing', region: 'Global' },
  { domain: 'emiratessteel.com', displayName: 'Emirates Steel Arkan', industry: 'Manufacturing', region: 'UAE' },
  { domain: 'ducab.com', displayName: 'Ducab', industry: 'Manufacturing', region: 'UAE' },
  { domain: 'schneider-electric.com', displayName: 'Schneider Electric', industry: 'Manufacturing', region: 'Global' },

  /* ---------------- Media & Entertainment ---------------- */
  { domain: 'mbc.net', displayName: 'MBC Group', industry: 'Media & Entertainment', region: 'Saudi Arabia' },
  { domain: 'aljazeera.net', displayName: 'Al Jazeera', industry: 'Media & Entertainment', region: 'GCC' },
  { domain: 'thenationalnews.com', displayName: 'The National', industry: 'Media & Entertainment', region: 'UAE' },
  { domain: 'gulfnews.com', displayName: 'Gulf News', industry: 'Media & Entertainment', region: 'UAE' },
  { domain: 'netflix.com', displayName: 'Netflix', industry: 'Media & Entertainment', region: 'Global' },
  { domain: 'spotify.com', displayName: 'Spotify', industry: 'Media & Entertainment', region: 'Global' },
  { domain: 'anghami.com', displayName: 'Anghami', industry: 'Media & Entertainment', region: 'UAE' },

  /* ---------------- Legal Services ---------------- */
  { domain: 'tamimi.com', displayName: 'Al Tamimi & Company', industry: 'Legal Services', region: 'UAE' },
  { domain: 'bakermckenzie.com', displayName: 'Baker McKenzie', industry: 'Legal Services', region: 'Global' },
  { domain: 'cliffordchance.com', displayName: 'Clifford Chance', industry: 'Legal Services', region: 'Global' },
  { domain: 'dlapiper.com', displayName: 'DLA Piper', industry: 'Legal Services', region: 'Global' },
  { domain: 'allenovery.com', displayName: 'A&O Shearman', industry: 'Legal Services', region: 'Global' },
  { domain: 'lexisnexis.com', displayName: 'LexisNexis', industry: 'Legal Services', region: 'Global',
    ownership: { ownershipType: 'subsidiary', parentName: 'RELX', parentDomain: 'relx.com',
      source: 'LexisNexis is a RELX business', sourceUrl: WIKI('LexisNexis') } },
  { domain: 'relx.com', displayName: 'RELX', industry: 'Legal Services', region: 'Global', isParentEntity: true },

  /* ---------------- Automotive ---------------- */
  { domain: 'alfuttaim.com', displayName: 'Al-Futtaim Group', industry: 'Automotive', region: 'UAE', isParentEntity: true },
  { domain: 'toyota.com', displayName: 'Toyota', industry: 'Automotive', region: 'Global' },
  { domain: 'bmw.com', displayName: 'BMW', industry: 'Automotive', region: 'Global' },
  { domain: 'audi.com', displayName: 'Audi', industry: 'Automotive', region: 'Global',
    ownership: { ownershipType: 'subsidiary', parentName: 'Volkswagen Group', parentDomain: 'volkswagen-group.com',
      source: 'Audi AG is majority owned by Volkswagen AG', sourceUrl: WIKI('Audi') } },
  { domain: 'volkswagen-group.com', displayName: 'Volkswagen Group', industry: 'Automotive', region: 'Global', isParentEntity: true },
  { domain: 'tesla.com', displayName: 'Tesla', industry: 'Automotive', region: 'Global' },
  { domain: 'lucidmotors.com', displayName: 'Lucid Motors', industry: 'Automotive', region: 'Global',
    ownership: { ownershipType: 'subsidiary', parentName: 'Public Investment Fund', parentDomain: 'pif.gov.sa',
      source: 'The Saudi Public Investment Fund holds a controlling stake', sourceUrl: WIKI('Lucid_Motors') } },

  /* ---------------- Food & Beverage ---------------- */
  { domain: 'almarai.com', displayName: 'Almarai', industry: 'Food & Beverage', region: 'Saudi Arabia' },
  { domain: 'savola.com', displayName: 'Savola Group', industry: 'Food & Beverage', region: 'Saudi Arabia' },
  { domain: 'agthia.com', displayName: 'Agthia Group', industry: 'Food & Beverage', region: 'UAE' },
  { domain: 'americana-food.com', displayName: 'Americana Restaurants', industry: 'Food & Beverage', region: 'UAE' },
  { domain: 'talabat.com', displayName: 'talabat', industry: 'Food & Beverage', region: 'UAE',
    ownership: { ownershipType: 'subsidiary', parentName: 'Delivery Hero', parentDomain: 'deliveryhero.com',
      source: 'Delivery Hero acquired talabat in 2015 and retains a majority stake', sourceUrl: WIKI('Talabat') } },
  { domain: 'deliveryhero.com', displayName: 'Delivery Hero', industry: 'Food & Beverage', region: 'Global', isParentEntity: true },
  { domain: 'nestle.com', displayName: 'Nestlé', industry: 'Food & Beverage', region: 'Global' },
];

/** Vendors grouped by industry, for reporting on dataset coverage. */
export function seedsByIndustry(): Map<string, VendorSeed[]> {
  const map = new Map<string, VendorSeed[]>();
  for (const seed of VENDOR_SEEDS) {
    const list = map.get(seed.industry) ?? [];
    list.push(seed);
    map.set(seed.industry, list);
  }
  return map;
}

export function findSeed(domain: string): VendorSeed | undefined {
  return VENDOR_SEEDS.find((s) => s.domain === domain);
}
