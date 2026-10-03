/**
 * How the OPTIONAL AI narration is unavailable.
 *
 * The chart is deterministic and computed entirely on-device: ascendant, moon,
 * dasha periods and the Life Atlas are complete and correct with no AI at all.
 * The written interpretation is an enhancement layered on top. So a provider
 * problem is NOT a broken product — it is one optional extra being unavailable,
 * and the UI must say so calmly, with the next step that actually fixes THAT
 * mode. This module is the single place that decides which mode a typed failure
 * belongs to, so the copy and the affordances stay in lockstep.
 */

import type { InterpretationErrorKind } from '@almamesh/store';

/**
 * The distinct ways the written interpretation can be missing, each with its own
 * copy and its own next step. Every value except `fault` is a graceful
 * degradation rendered in a calm, secondary treatment.
 */
export type NarrationOutage =
  /** Nothing is connected yet — setup, not failure. */
  | 'no_key'
  /** The provider account has no balance left: add credits or go cheaper. */
  | 'credits'
  /**
   * Rate-limited / 5xx / unreachable / a model that thought past the reasoning
   * cap — transient and not the user's doing.
   */
  | 'provider_down'
  /** The saved API key was rejected. */
  | 'auth'
  /** The saved model slug no longer exists on the endpoint. */
  | 'model'
  /** A GENUINE defect (privacy refusal, app-state error, unclassified). */
  | 'fault';

/**
 * Map a recorded failure kind to the way the UI should degrade.
 *
 * Anything that is not a known provider-side condition — including a legacy
 * entry with no recorded kind — stays a `fault` on purpose: a real bug must not
 * hide behind reassuring copy.
 */
export function narrationOutage(kind: InterpretationErrorKind | null): NarrationOutage {
  switch (kind) {
    case 'credits':
      return 'credits';
    case 'auth':
      return 'auth';
    case 'model':
      return 'model';
    case 'rate_limited':
    case 'reasoning_timeout':
    case 'server':
    case 'network':
      return 'provider_down';
    default:
      return 'fault';
  }
}
