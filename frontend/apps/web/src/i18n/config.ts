/**
 * i18next initialization — OFFLINE, bundled catalogs (no runtime fetch).
 *
 * Every translation JSON is imported STATICALLY below, so Vite bundles + hashes
 * them and the PWA service worker precaches them. The app never reaches the
 * network for strings: it works fully offline and stays zero-egress, exactly
 * like the rest of AlmaMesh (the only outbound calls are the optional, opt-in
 * AI endpoint the user configures).
 *
 * The initial language is decided by the persisted language store (see
 * `@almamesh/store` `useLanguageStore`); a small effect in App.tsx keeps
 * i18next and `<html lang>` in sync on every change. `lng` here is just the
 * boot default — the store overrides it immediately on mount.
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getInitialLanguage, type Language } from '@almamesh/store';

// --- English (authoritative) ---
import enCommon from '../locales/en/common.json';
import enOnboarding from '../locales/en/onboarding.json';
import enDashboard from '../locales/en/dashboard.json';
import enChat from '../locales/en/chat.json';
import enReport from '../locales/en/report.json';
import enSettings from '../locales/en/settings.json';
import enAstrology from '../locales/en/astrology.json';
import enLegal from '../locales/en/legal.json';
import enErrors from '../locales/en/errors.json';
import enPredictive from '../locales/en/predictive.json';
import enLife from '../locales/en/life.json';
import enMesh from '../locales/en/mesh.json';
import enLanding from '../locales/en/landing.json';
import enRectify from '../locales/en/rectify.json';
import enFeedback from '../locales/en/feedback.json';

// --- Spanish ---
import esCommon from '../locales/es/common.json';
import esOnboarding from '../locales/es/onboarding.json';
import esDashboard from '../locales/es/dashboard.json';
import esChat from '../locales/es/chat.json';
import esReport from '../locales/es/report.json';
import esSettings from '../locales/es/settings.json';
import esAstrology from '../locales/es/astrology.json';
import esLegal from '../locales/es/legal.json';
import esErrors from '../locales/es/errors.json';
import esPredictive from '../locales/es/predictive.json';
import esLife from '../locales/es/life.json';
import esMesh from '../locales/es/mesh.json';
import esLanding from '../locales/es/landing.json';
import esRectify from '../locales/es/rectify.json';
import esFeedback from '../locales/es/feedback.json';

// --- Portuguese ---
import ptCommon from '../locales/pt/common.json';
import ptOnboarding from '../locales/pt/onboarding.json';
import ptDashboard from '../locales/pt/dashboard.json';
import ptChat from '../locales/pt/chat.json';
import ptReport from '../locales/pt/report.json';
import ptSettings from '../locales/pt/settings.json';
import ptAstrology from '../locales/pt/astrology.json';
import ptLegal from '../locales/pt/legal.json';
import ptErrors from '../locales/pt/errors.json';
import ptPredictive from '../locales/pt/predictive.json';
import ptLife from '../locales/pt/life.json';
import ptMesh from '../locales/pt/mesh.json';
import ptLanding from '../locales/pt/landing.json';
import ptRectify from '../locales/pt/rectify.json';
import ptFeedback from '../locales/pt/feedback.json';

// --- Hindi ---
import hiCommon from '../locales/hi/common.json';
import hiOnboarding from '../locales/hi/onboarding.json';
import hiDashboard from '../locales/hi/dashboard.json';
import hiChat from '../locales/hi/chat.json';
import hiReport from '../locales/hi/report.json';
import hiSettings from '../locales/hi/settings.json';
import hiAstrology from '../locales/hi/astrology.json';
import hiLegal from '../locales/hi/legal.json';
import hiErrors from '../locales/hi/errors.json';
import hiPredictive from '../locales/hi/predictive.json';
import hiLife from '../locales/hi/life.json';
import hiMesh from '../locales/hi/mesh.json';
import hiLanding from '../locales/hi/landing.json';
import hiRectify from '../locales/hi/rectify.json';
import hiFeedback from '../locales/hi/feedback.json';

/** The namespaces registered now (later agents fill the per-screen strings). */
export const I18N_NAMESPACES = [
  'common',
  'onboarding',
  'dashboard',
  'chat',
  'report',
  'settings',
  'astrology',
  'legal',
  'errors',
  'predictive',
  'life',
  'mesh',
  'landing',
  'rectify',
  'feedback',
] as const;

const resources = {
  en: {
    common: enCommon,
    onboarding: enOnboarding,
    dashboard: enDashboard,
    chat: enChat,
    report: enReport,
    settings: enSettings,
    astrology: enAstrology,
    legal: enLegal,
    errors: enErrors,
    predictive: enPredictive,
    life: enLife,
    mesh: enMesh,
    landing: enLanding,
    rectify: enRectify,
    feedback: enFeedback,
  },
  es: {
    common: esCommon,
    onboarding: esOnboarding,
    dashboard: esDashboard,
    chat: esChat,
    report: esReport,
    settings: esSettings,
    astrology: esAstrology,
    legal: esLegal,
    errors: esErrors,
    predictive: esPredictive,
    life: esLife,
    mesh: esMesh,
    landing: esLanding,
    rectify: esRectify,
    feedback: esFeedback,
  },
  pt: {
    common: ptCommon,
    onboarding: ptOnboarding,
    dashboard: ptDashboard,
    chat: ptChat,
    report: ptReport,
    settings: ptSettings,
    astrology: ptAstrology,
    legal: ptLegal,
    errors: ptErrors,
    predictive: ptPredictive,
    life: ptLife,
    mesh: ptMesh,
    landing: ptLanding,
    rectify: ptRectify,
    feedback: ptFeedback,
  },
  hi: {
    common: hiCommon,
    onboarding: hiOnboarding,
    dashboard: hiDashboard,
    chat: hiChat,
    report: hiReport,
    settings: hiSettings,
    astrology: hiAstrology,
    legal: hiLegal,
    errors: hiErrors,
    predictive: hiPredictive,
    life: hiLife,
    mesh: hiMesh,
    landing: hiLanding,
    rectify: hiRectify,
    feedback: hiFeedback,
  },
} as const;

const initialLanguage: Language = getInitialLanguage();

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: 'en',
  supportedLngs: ['en', 'es', 'pt', 'hi'],
  ns: I18N_NAMESPACES,
  defaultNS: 'common',
  returnNull: false,
  interpolation: { escapeValue: false },
});

export default i18n;
