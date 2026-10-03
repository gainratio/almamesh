/**
 * Seal each life domain's calibrated strength summary into an offline-verifiable
 * Ed25519 receipt — in TypeScript, on the main Worker thread, NOT inside Pyodide.
 *
 * WHY TypeScript and not the Python kernel: the Python `avow` envelope signs via
 * PyNaCl, whose `_sodium` compiled extension does not register under this app's
 * Pyodide boot (plain `nacl`, `cffi` and `_cffi_backend` all load; only the
 * compiled dylib fails, immediately after `loadPackage`). Rather than fight an
 * unresolved loader defect, signing moves to `@gainratio/avow` — the same envelope,
 * pure JS (`@noble/ed25519` + RFC-8785 JCS), byte-compatible with the Python
 * kernel. The engine stays pure computation in both runtimes and the browser boot
 * stops paying for a crypto dylib it cannot load anyway.
 *
 * "Byte-compatible" is PROVEN, not asserted: `testdata/vectors/` holds receipts
 * minted by the Python kernel, and `__tests__/strengthReceipt.test.ts` requires
 * this module to reproduce them signature-for-signature (and to verify Python's
 * own receipts). Both language suites read that one file.
 *
 * WHAT A RECEIPT DOES AND DOES NOT CLAIM. The signing key is generated per Worker
 * boot and never leaves the device, so it does NOT survive a reload. A receipt is
 * therefore TAMPER-EVIDENCE for a stored or exported summary — mutate a
 * `strength_pct` after the fact and verification fails — and NOT an attestation of
 * who computed it. A browser cannot keep a secret from its own operator, so a
 * shipped shared key would only manufacture a forgeable identity that LOOKS
 * authoritative. Device-local is the honest local-first primitive.
 *
 * The receipt introduces NO number of its own: the payload is the engine's
 * `StrengthSummary` verbatim. The no-fake-precision covenant gains a proof
 * without gaining a claim.
 */

import {
  contentHash,
  type JsonValue,
  type SignedReceipt,
  signPayload,
  verifySignature,
} from "@gainratio/avow";

import type { LifeDomainsContext, StrengthSummary } from "./predictive";
import { composeDomainStrength, type DomainStrengthAssayResult } from "./strengthAssay";

/**
 * The signed claim: THIS domain scored THIS calibrated summary. The full summary
 * is embedded (both axes, band, tier, covenant note) so a receipt can never
 * assert a headline % detached from its derivation.
 */
export interface DomainStrengthSubject {
  readonly domain: string;
  readonly summary: StrengthSummary;
}

/**
 * One domain's strength summary, Ed25519-sealed.
 *
 * Built from `SignedReceipt<JsonValue>` (not `SignedReceipt<DomainStrengthSubject>`
 * directly) with `payload` re-narrowed to the named type: a named interface has
 * no index signature, so it does not itself satisfy the `S extends JsonValue`
 * generic constraint — the same seam `asJsonSubject` already bridges at the
 * value level, applied here at the type level.
 */
export type DomainStrengthReceipt = Omit<SignedReceipt<JsonValue>, "payload"> & {
  readonly payload: DomainStrengthSubject;
};

/**
 * The subject is, by construction, the JSON the Python engine already dumped —
 * every leaf is a string, number or boolean. TypeScript cannot see that a named
 * interface satisfies an index-signature type, so this is the documented seam
 * where a typed model meets the serialization boundary. It widens nothing: the
 * canonicalizer would throw `CanonicalizationFailed` on a non-JSON leaf.
 */
function asJsonSubject(subject: DomainStrengthSubject): JsonValue {
  return subject as unknown as JsonValue;
}

/** Freeze one domain + summary into a subject and Ed25519-sign it. */
export async function signDomainStrength(
  domain: string,
  summary: StrengthSummary,
  seedHex: string,
): Promise<DomainStrengthReceipt> {
  const subject: DomainStrengthSubject = { domain, summary };
  const receipt = await signPayload(asJsonSubject(subject), seedHex);
  return { ...receipt, payload: subject };
}

/**
 * Seal EVERY computed domain summary — no domain may ship unsealed. Sealing is
 * total by construction (one receipt per `forecasts` entry) so a caller can never
 * quietly narrow which strength claims are provable.
 */
export async function sealDomainStrengths(
  domains: LifeDomainsContext,
  seedHex: string,
): Promise<Record<string, DomainStrengthReceipt>> {
  const entries = await Promise.all(
    Object.entries(domains.forecasts).map(
      async ([domain, forecast]): Promise<readonly [string, DomainStrengthReceipt]> => [
        domain,
        await signDomainStrength(domain, forecast.strength_summary, seedHex),
      ],
    ),
  );
  return Object.fromEntries(entries);
}

/**
 * Verify a strength receipt offline against a pinned signer. Throws a coded
 * `avow` error on any failure, naming WHICH gate rejected it:
 *
 * - `ReceiptSchemaMismatch` — the receipt does not declare `avow.receipt/v1`
 *   (avow 0.5+). Receipts never outlive their Worker boot, so no stored
 *   schema-less 0.1-format receipt can reach this check.
 * - `PayloadHashMismatch` — the payload was edited, so its recomputed content-hash
 *   no longer matches the hash stored in the receipt.
 * - `SignerMismatch` — a PROVENANCE failure: the receipt's embedded key is not
 *   the key the caller pinned, so the signature is never even checked.
 * - `SignatureBytesInvalid` — a TAMPER failure: the right signer, but the
 *   Ed25519 check rejected the signature bytes.
 *
 * The latter two both extend `SignatureInvalid`, so a caller that only needs
 * "did not verify, for any reason" still catches a single base class and
 * nothing about WHICH receipts are rejected changes. The distinction matters
 * for testing as much as for alerting: the first three cases short-circuit
 * BEFORE the signature check, so only `SignatureBytesInvalid` can prove
 * Ed25519 actually ran (see `__tests__/strengthReceipt.test.ts`).
 */
export async function verifyDomainStrength(
  receipt: DomainStrengthReceipt,
  expectedPublicKey: string,
): Promise<void> {
  await verifySignature(
    { ...receipt, payload: asJsonSubject(receipt.payload) },
    expectedPublicKey,
  );
}

/**
 * Verify the receipt and bind its signed subject to the domain summary the UI
 * or PDF is about to show. A valid receipt for a different snapshot is not
 * evidence for the current claim, even when it came from the same boot key.
 */
export async function verifyDomainStrengthClaim(
  receipt: DomainStrengthReceipt,
  expectedPublicKey: string,
  domain: string,
  summary: StrengthSummary,
  assay?: DomainStrengthAssayResult,
): Promise<void> {
  await verifyDomainStrength(receipt, expectedPublicKey);
  const expectedHash = await contentHash(asJsonSubject({ domain, summary }));
  if (expectedHash !== receipt.payload_hash) {
    throw new Error("Receipt does not match the current domain strength");
  }
  if (assay) {
    const expectedAssay = composeDomainStrength(summary);
    const actualAssayHash = await contentHash(assay as unknown as JsonValue);
    const expectedAssayHash = await contentHash(expectedAssay as unknown as JsonValue);
    if (actualAssayHash !== expectedAssayHash) {
      throw new Error("Assay does not match the current domain strength");
    }
  }
}
