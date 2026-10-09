/**
 * Mesh test fixtures — a fully-typed, UI-shaped `MeshEdgeCtx` (the store's
 * adapted form) with distinctive values the page tests assert verbatim.
 *
 * The shape mirrors the engine's `MeshEdgeContext` (schemas/mesh.py) exactly;
 * `a` is the ANCHOR's chart, `b` the MEMBER's, per the store contract.
 */

import type {
  ChartOverlayData,
  MangalDoshaData,
  MeshEdgeCtx,
  RelationSignificatorsData,
} from '@almamesh/shared-types';

const B_IN_A_OVERLAY: ChartOverlayData = {
  host_lagna_sign: 'aquarius',
  placements: [
    { planet: 'sun', sign: 'cancer', host_house: 6 },
    { planet: 'moon', sign: 'taurus', host_house: 4 },
    { planet: 'venus', sign: 'gemini', host_house: 5 },
  ],
  contacts: [
    {
      planet: 'venus',
      target: 'moon',
      kind: 'close_conjunction',
      host_house: 5,
      orb_degrees: 2.1,
      heuristic: false,
      source: 'Synastry overlay — modern close-conjunction orb',
    },
    {
      planet: 'saturn',
      target: 'lagna',
      kind: 'graha_drishti',
      host_house: 7,
      orb_degrees: null,
      heuristic: true,
      source: 'BPHS graha dṛṣṭi, whole-sign',
    },
  ],
  conjunction_orb_degrees: 6,
  convention: 'whole-sign houses; 6° close-conjunction orb (modern)',
};

const A_IN_B_OVERLAY: ChartOverlayData = {
  host_lagna_sign: 'leo',
  placements: [
    { planet: 'sun', sign: 'capricorn', host_house: 6 },
    { planet: 'jupiter', sign: 'taurus', host_house: 10 },
  ],
  contacts: [
    {
      planet: 'jupiter',
      target: 'sun',
      kind: 'same_sign',
      host_house: 10,
      orb_degrees: null,
      heuristic: false,
      source: 'Synastry overlay — same sidereal sign',
    },
  ],
  conjunction_orb_degrees: 6,
  convention: 'whole-sign houses; 6° close-conjunction orb (modern)',
};

const MANGAL_A: MangalDoshaData = {
  references: [
    {
      reference: 'lagna',
      school: 'BPHS',
      mars_sign: 'aries',
      mars_house: 4,
      in_dosha_house: true,
      cancellations: [],
      net_dosha: true,
      source: 'BPHS Mangal dosha houses from the Lagna',
    },
    {
      reference: 'moon',
      school: 'BPHS',
      mars_sign: 'aries',
      mars_house: 12,
      in_dosha_house: true,
      cancellations: [
        {
          rule: 'own_sign_mars',
          description: 'Mars occupies its own sign',
          source: 'classical cancellation',
        },
      ],
      net_dosha: false,
      source: 'BPHS Mangal dosha houses from the Moon',
    },
    {
      reference: 'venus',
      school: 'South Indian usage',
      mars_sign: 'aries',
      mars_house: 3,
      in_dosha_house: false,
      cancellations: [],
      net_dosha: false,
      source: 'Mangal dosha houses from Venus',
    },
  ],
  has_dosha: true,
  convention: 'net dosha per reference after classical cancellations',
};

const MANGAL_B: MangalDoshaData = {
  references: [
    {
      reference: 'lagna',
      school: 'BPHS',
      mars_sign: 'scorpio',
      mars_house: 7,
      in_dosha_house: true,
      cancellations: [],
      net_dosha: true,
      source: 'BPHS Mangal dosha houses from the Lagna',
    },
    {
      reference: 'moon',
      school: 'BPHS',
      mars_sign: 'scorpio',
      mars_house: 5,
      in_dosha_house: false,
      cancellations: [],
      net_dosha: false,
      source: 'BPHS Mangal dosha houses from the Moon',
    },
    {
      reference: 'venus',
      school: 'South Indian usage',
      mars_sign: 'scorpio',
      mars_house: 2,
      in_dosha_house: true,
      cancellations: [],
      net_dosha: true,
      source: 'Mangal dosha houses from Venus',
    },
  ],
  has_dosha: true,
  convention: 'net dosha per reference after classical cancellations',
};

const SIGNIFICATORS_A: RelationSignificatorsData = {
  relationship: 'spouse',
  karaka_house: 7,
  house_basis: '7th house from the Lagna (BPHS)',
  house_sign: 'leo',
  house_lord: 'sun',
  lord_condition: {
    planet: 'sun',
    sign: 'aries',
    house: 3,
    dignity: 'exalted',
    is_retrograde: false,
    is_combust: false,
  },
  occupants: ['venus'],
  karakas: [
    {
      condition: {
        planet: 'venus',
        sign: 'taurus',
        house: 4,
        dignity: 'own',
        is_retrograde: false,
        is_combust: false,
      },
      source: 'Śukra as kāraka of spouse (BPHS)',
    },
  ],
};

const SIGNIFICATORS_B: RelationSignificatorsData = {
  relationship: 'spouse',
  karaka_house: 7,
  house_basis: '7th house from the Lagna (BPHS)',
  house_sign: 'aquarius',
  house_lord: 'saturn',
  lord_condition: {
    planet: 'saturn',
    sign: 'libra',
    house: 3,
    dignity: 'exalted',
    is_retrograde: true,
    is_combust: false,
  },
  occupants: [],
  karakas: [
    {
      condition: {
        planet: 'venus',
        sign: 'gemini',
        house: 11,
        dignity: 'friend',
        is_retrograde: false,
        is_combust: true,
      },
      source: 'Śukra as kāraka of spouse (BPHS)',
    },
  ],
};

/** A spouse edge with distinctive numbers the tests assert verbatim. */
export const MESH_EDGE_SPOUSE: MeshEdgeCtx = {
  relationship: 'spouse',
  role_a: 'bride',
  role_b: 'groom',
  ashtakoota: {
    bride_moon: {
      nakshatra: 'Rohini',
      nakshatra_index: 3,
      nakshatra_pada: 2,
      sign: 'taurus',
      sign_degrees: 12.5,
    },
    groom_moon: {
      nakshatra: 'Magha',
      nakshatra_index: 9,
      nakshatra_pada: 1,
      sign: 'leo',
      sign_degrees: 3.1,
    },
    kootas: [
      { koota: 'varna', earned: 1, maximum: 1, basis: 'Same varna', source: 'Guna Milan tables' },
      { koota: 'vashya', earned: 2, maximum: 2, basis: 'Mutual vashya', source: 'Guna Milan tables' },
      { koota: 'tara', earned: 1.5, maximum: 3, basis: 'Mixed tārā count', source: 'Guna Milan tables' },
      { koota: 'yoni', earned: 2, maximum: 4, basis: 'Neutral yoni pair', source: 'Guna Milan tables' },
      {
        koota: 'graha_maitri',
        earned: 4,
        maximum: 5,
        basis: 'Moon-sign lords are friends one way, neutral the other',
        source: 'Guna Milan tables',
      },
      { koota: 'gana', earned: 6, maximum: 6, basis: 'Same gaṇa', source: 'Guna Milan tables' },
      { koota: 'bhakoot', earned: 0, maximum: 7, basis: '6/8 sign pairing', source: 'Guna Milan tables' },
      { koota: 'nadi', earned: 8, maximum: 8, basis: 'Different nāḍī', source: 'Guna Milan tables' },
    ],
    total: 24.5,
    maximum: 36,
    band: 'good',
    band_basis: '24.5 of 36 falls in the classical "good" band (18–24+)',
    bhakoot_dosha: {
      name: 'bhakoot_dosha',
      present: true,
      cancelled: true,
      cancellations: [
        {
          rule: 'same_lord',
          description: 'Both Moon signs share one lord',
          source: 'classical Bhakoot cancellation',
        },
      ],
      basis: '6/8 pairing raises Bhakoot dosha; shared lordship cancels it',
      source: 'Guna Milan tables',
    },
    nadi_dosha: {
      name: 'nadi_dosha',
      present: false,
      cancelled: false,
      cancellations: [],
      basis: 'Different nāḍī — no dosha',
      source: 'Guna Milan tables',
    },
    source: 'Ashtakoota Guna Milan (classical tables)',
  },
  mangal_match: {
    a: MANGAL_A,
    b: MANGAL_B,
    mutually_cancelled: true,
    compatible: true,
    basis: 'Both charts carry the dosha; mutual presence is read as cancelled',
    source: 'Mangal dosha matching convention',
  },
  overlay: { b_in_a: B_IN_A_OVERLAY, a_in_b: A_IN_B_OVERLAY },
  synchrony: {
    window_start: '2026-06-11T00:00:00Z',
    window_end: '2028-06-11T00:00:00Z',
    segments: [
      {
        start: '2026-06-11T00:00:00Z',
        end: '2027-01-08T04:52:00Z',
        a_maha: 'saturn',
        a_antar: 'mercury',
        b_maha: 'jupiter',
        b_antar: 'venus',
        shared_lords: [],
        simultaneous_boundary: false,
      },
      {
        start: '2027-01-08T04:52:00Z',
        end: '2028-06-11T00:00:00Z',
        a_maha: 'saturn',
        a_antar: 'venus',
        b_maha: 'venus',
        b_antar: 'sun',
        shared_lords: ['venus'],
        simultaneous_boundary: true,
      },
    ],
    convention_a: 'gregorian_365_2425',
    convention_b: 'gregorian_365_2425',
    basis: 'Vimśottarī mahā/antar legs joined over the explicit window',
  },
  significators_a: SIGNIFICATORS_A,
  significators_b: SIGNIFICATORS_B,
  integrity_note:
    'Relations are computed FROM two finished natal charts; neither chart is recomputed, reweighted or altered by the other.',
};

/** The same pair read as a friendship — marriage tables must NOT render. */
export const MESH_EDGE_FRIEND: MeshEdgeCtx = {
  ...MESH_EDGE_SPOUSE,
  relationship: 'friend',
  significators_a: {
    ...SIGNIFICATORS_A,
    relationship: 'friend',
    karaka_house: 11,
    house_basis: '11th house from the Lagna (gains and friends)',
  },
  significators_b: {
    ...SIGNIFICATORS_B,
    relationship: 'friend',
    karaka_house: 11,
    house_basis: '11th house from the Lagna (gains and friends)',
  },
};
