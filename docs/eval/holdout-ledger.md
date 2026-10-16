# HELD-OUT ledger

Every HELD-OUT look is logged here before it runs. Aggregates only.

| Date | Look | Pre-registration | Status |
|---|---|---|---|
| 2026-10-14 | zero: two full-set runs before the split saw every native in aggregate | amendment (d1) | done |
| 2026-10-16 | (g1) relocation under +EXACT, k=3, window +/-36 | amendment (i) | run once: NOT CONFIRMED (lift 0.69, p 0.717, n 71); lead closed |

## Rule from here on

The HELD-OUT half is spent for (g1) and (i): it was looked at once for each, and the result
was a null. **Any further HELD-OUT look needs a new pre-registration**, committed before the
run, with its own row in the table above. Looking again under an old amendment, or after
tuning on what the first look showed, is not a look; it is a second draw. The guard that
enforces the mechanical part is `--release-look` plus the pinned `ADB_SPLIT_DIGEST`; the
pre-registration is the human part.
