import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PayloadHashMismatch,
  RECEIPT_SCHEMA,
  ReceiptSchemaMismatch,
  SignatureBytesInvalid,
  SignatureInvalid,
  SignerMismatch,
  generateSeedHex,
  publicKeyHex,
} from "@gainratio/avow";

import {
  sealDomainStrengths,
  signDomainStrength,
  verifyDomainStrength,
  verifyDomainStrengthClaim,
  type DomainStrengthSubject,
} from "../strengthReceipt";
import { composeDomainStrength } from "../strengthAssay";
import type { LifeDomainsContext, StrengthSummary } from "../predictive";

const HERE = dirname(fileURLToPath(import.meta.url));
// repo-root/testdata — the ONE fixture both language suites consume.
const VECTORS = resolve(HERE, "../../../../../../testdata/vectors/domain-strength-receipt.json");

interface ReceiptVector {
  readonly subject: DomainStrengthSubject;
  readonly canonical_hex: string;
  readonly payload_hash: string;
  readonly signature: string;
}
interface VectorFile {
  readonly receipt_schema: string;
  readonly seed_hex: string;
  readonly public_key: string;
  readonly receipts: readonly ReceiptVector[];
}

const vectors: VectorFile = JSON.parse(readFileSync(VECTORS, "utf8")) as VectorFile;

function summary(overrides: Partial<StrengthSummary> = {}): StrengthSummary {
  return {
    key_graha: "saturn",
    key_graha_rupas: 7.5,
    key_graha_meets_minimum: true,
    sav_bindus: 31,
    band: "moderate",
    shadbala_pct: 60,
    sav_pct: 55.357142857142854,
    strength_pct: 55.357142857142854,
    strength_tier: "model",
    approximated: true,
    note: "test fixture",
    ...overrides,
  } as StrengthSummary;
}

function domainsContext(domains: readonly string[]): LifeDomainsContext {
  const forecasts = Object.fromEntries(
    domains.map((domain, index) => [
      domain,
      // Only `strength_summary` is read by the sealer; the rest of the forecast
      // is irrelevant to the receipt and deliberately left minimal here.
      { domain, strength_summary: summary({ sav_bindus: 20 + index }) },
    ]),
  );
  return { instant: "2026-07-11T12:00:00Z", forecasts } as unknown as LifeDomainsContext;
}

/**
 * THE byte-compatibility proof. These vectors were produced by the PYTHON `avow`
 * kernel (rfc8785 + PyNaCl). If the TypeScript signer diverges by even one byte —
 * key ordering, float formatting, hash input — these fail. This is what licenses
 * moving signing out of Pyodide and into the Worker's TypeScript.
 */
describe("golden vectors: TS signing is byte-identical to the Python avow kernel", () => {
  it("has vectors covering the JCS number hazards", () => {
    expect(vectors.receipts.length).toBeGreaterThanOrEqual(2);
    // 60.0 -> 60, 5.0 -> 5, 1e-07 -> 1e-7 are exactly where a naive encoder drifts.
    const hexes = vectors.receipts.map((r) => r.canonical_hex).join("");
    expect(hexes).toContain("36302c"); // ..."shadbala_pct":60,
    expect(hexes).toContain("31652d372c"); // ..."sav_pct":1e-7,
  });

  for (const vector of vectors.receipts) {
    it(`reproduces Python's receipt for domain "${vector.subject.domain}"`, async () => {
      const receipt = await signDomainStrength(
        vector.subject.domain,
        vector.subject.summary,
        vectors.seed_hex,
      );

      expect(receipt.schema).toBe(vectors.receipt_schema);
      expect(receipt.payload_hash).toBe(vector.payload_hash);
      expect(receipt.signature).toBe(vector.signature);
      expect(receipt.public_key).toBe(vectors.public_key);
      expect(receipt.payload).toEqual(vector.subject);
    });

    it(`verifies Python's own receipt for domain "${vector.subject.domain}"`, async () => {
      // The other direction: a receipt minted in Python must verify in TypeScript.
      await expect(
        verifyDomainStrength(
          {
            schema: RECEIPT_SCHEMA,
            payload: vector.subject,
            payload_hash: vector.payload_hash,
            public_key: vectors.public_key,
            signature: vector.signature,
          },
          vectors.public_key,
        ),
      ).resolves.toBeUndefined();
    });
  }

  it("pins the receipt envelope schema both kernels emit", () => {
    // avow 0.5 made the envelope self-describing. The vectors record the schema
    // Python's sign_payload emitted, so a schema bump in either kernel fails here.
    expect(vectors.receipt_schema).toBe("avow.receipt/v1");
    expect(RECEIPT_SCHEMA).toBe(vectors.receipt_schema);
  });

  it("refuses a schema-less (avow 0.1-format) receipt", async () => {
    // AlmaMesh never persists receipts (the per-boot signer dies with the Worker,
    // and the predictive store strips them), so no stored 0.1 receipt can reach
    // this path. Pin the refusal so a future persistence change cannot quietly
    // start verifying a format the kernel rejects.
    const [vector] = vectors.receipts;
    const legacy = {
      payload: vector.subject,
      payload_hash: vector.payload_hash,
      public_key: vectors.public_key,
      signature: vector.signature,
    } as unknown as Parameters<typeof verifyDomainStrength>[0];
    await expect(verifyDomainStrength(legacy, vectors.public_key)).rejects.toBeInstanceOf(
      ReceiptSchemaMismatch,
    );
  });

  it("derives the vector's public key from the vector's seed", async () => {
    expect(await publicKeyHex(vectors.seed_hex)).toBe(vectors.public_key);
  });
});

describe("verifyDomainStrengthClaim", () => {
  it("accepts only a genuine receipt for the domain summary currently being shown", async () => {
    const seed = generateSeedHex();
    const key = await publicKeyHex(seed);
    const current = summary();
    const receipt = await signDomainStrength("career", current, seed);

    await expect(
      verifyDomainStrengthClaim(receipt, key, "career", current),
    ).resolves.toBeUndefined();
    await expect(
      verifyDomainStrengthClaim(
        receipt,
        key,
        "career",
        summary({ strength_pct: current.strength_pct + 1 }),
      ),
    ).rejects.toThrow(/current domain strength/i);
    await expect(
      verifyDomainStrengthClaim(receipt, key, "finances", current),
    ).rejects.toThrow(/current domain strength/i);
  });

  it("rejects altered Assay details even when the signed summary is unchanged", async () => {
    const seed = generateSeedHex();
    const key = await publicKeyHex(seed);
    const current = summary();
    const receipt = await signDomainStrength("career", current, seed);
    const assay = composeDomainStrength(current);
    const altered = {
      ...assay,
      components: assay.components.map((component) =>
        component.id === assay.selected_component_id ? { ...component, raw: 99 } : component,
      ),
    };

    await expect(
      verifyDomainStrengthClaim(receipt, key, "career", current, assay),
    ).resolves.toBeUndefined();
    await expect(
      verifyDomainStrengthClaim(receipt, key, "career", current, altered),
    ).rejects.toThrow(/assay.*current domain strength/i);
  });
});

describe("sealDomainStrengths", () => {
  it("seals EVERY forecast — sealing is total, never a narrowed subset", async () => {
    const seed = generateSeedHex();
    const ctx = domainsContext(["career", "finances", "health"]);

    const receipts = await sealDomainStrengths(ctx, seed);

    expect(Object.keys(receipts).sort()).toEqual(["career", "finances", "health"]);
  });

  it("seals the summary VERBATIM — the receipt introduces no new number", async () => {
    const seed = generateSeedHex();
    const ctx = domainsContext(["career"]);

    const receipts = await sealDomainStrengths(ctx, seed);

    expect(receipts.career.payload.summary).toEqual(ctx.forecasts.career.strength_summary);
    expect(receipts.career.payload.domain).toBe("career");
  });

  it("round-trips: every sealed receipt verifies under the sealing key", async () => {
    const seed = generateSeedHex();
    const expected = await publicKeyHex(seed);
    const ctx = domainsContext(["career", "finances"]);

    const receipts = await sealDomainStrengths(ctx, seed);

    for (const receipt of Object.values(receipts)) {
      await expect(verifyDomainStrength(receipt, expected)).resolves.toBeUndefined();
    }
  });

  it("is deterministic: identical facts under one key seal to identical bytes", async () => {
    const seed = generateSeedHex();
    const ctx = domainsContext(["career"]);

    const first = await sealDomainStrengths(ctx, seed);
    const second = await sealDomainStrengths(ctx, seed);

    expect(first.career.signature).toBe(second.career.signature);
  });
});

/**
 * Verification has THREE independent gates, and they fail in a fixed order:
 * content-hash, then pinned signer, then Ed25519 signature bytes. Each test
 * below pins the SPECIFIC coded error, not the shared `SignatureInvalid` base,
 * because a test that only asserts the base cannot tell the reader which gate
 * actually fired — and a loose assertion silently stands in as "signature
 * coverage" while never reaching the signature check at all.
 *
 * That was a real gap here: before the last test in this block existed, forcing
 * avow's Ed25519 verdict to always-succeed left this whole file green. The two
 * tamper cases both short-circuit BEFORE the signature — the mutated payload
 * dies at the hash compare, the wrong key dies at the signer compare — so
 * neither one can ever prove the signature check runs.
 */
describe("verifyDomainStrength fails closed", () => {
  it("detects a mutated strength_pct at the HASH gate, before the signature", async () => {
    const seed = generateSeedHex();
    const expected = await publicKeyHex(seed);
    const receipt = await signDomainStrength("career", summary(), seed);

    const tampered = {
      ...receipt,
      payload: { ...receipt.payload, summary: { ...receipt.payload.summary, strength_pct: 99 } },
    };

    // `payload_hash` is left stale, so this dies at the content-hash compare.
    // PayloadHashMismatch is NOT a SignatureInvalid — asserted explicitly so this
    // case can never be miscounted as coverage of the signature check.
    const error = await verifyDomainStrength(tampered, expected).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayloadHashMismatch);
    expect(error).not.toBeInstanceOf(SignatureInvalid);
  });

  it("rejects a receipt that is not from the pinned signer at the SIGNER gate", async () => {
    const receipt = await signDomainStrength("career", summary(), generateSeedHex());
    const other = await publicKeyHex(generateSeedHex());

    // The embedded key is compared to the pinned key before the signature is
    // ever checked, so this is a PROVENANCE failure (`SignerMismatch`), not a
    // signature failure. Pinning the subclass keeps the distinction executable.
    const error = await verifyDomainStrength(receipt, other).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignerMismatch);
    expect(error).not.toBeInstanceOf(SignatureBytesInvalid);
  });

  it("rejects corrupted signature bytes — the one case Ed25519 exists to catch", async () => {
    const seed = generateSeedHex();
    const expected = await publicKeyHex(seed);
    const receipt = await signDomainStrength("career", summary(), seed);

    // Flip ONE hex nibble of the signature and nothing else. `payload` is
    // untouched so `payload_hash` still matches, and `public_key` is still the
    // pinned signer — so both earlier gates PASS and control reaches the
    // Ed25519 check. This is the only test in the file that does.
    const nibble = receipt.signature[0];
    const forged = {
      ...receipt,
      signature: (nibble === "0" ? "1" : "0") + receipt.signature.slice(1),
    };
    expect(forged.signature).not.toBe(receipt.signature);
    expect(forged.signature).toHaveLength(receipt.signature.length);
    expect(forged.payload_hash).toBe(receipt.payload_hash);
    expect(forged.public_key).toBe(expected);

    const error = await verifyDomainStrength(forged, expected).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignatureBytesInvalid);
    expect(error).not.toBeInstanceOf(SignerMismatch);
  });
});
