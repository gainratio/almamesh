# Retrodiction eval

**TL;DR.** This eval asks one question: if you take people with known life events (a marriage,
a job loss, an accident) and rank every month in a window around each event by what the
engine's indicators say, does the real month rank near the top more often than chance? We ran
it on a large licensed set of birth records. **No technique beats chance.** Overall lift at
top-3 is 0.90 [0.75, 1.08] on a 3,000-native sample and 0.96 [0.88, 1.05] on the full set
(1.0 means chance). No category survives multiple-comparison correction. The one early lead
(relocation under exact transits, DEV lift 4.56) did not replicate on the held-out half
(0.69 [0.08, 1.95], p 0.717). Public write-up: <https://almamesh.com/how-we-test>.

**Why it exists.** A reading that sounds right is not evidence. This is the check that would
embarrass us if the engine were only telling stories, and it did. The product says so.

## What ships and what does not

The code ships, so anyone can reproduce the method. The licensed data never does: the
Astro-Databank export is confidential, so the repo holds no names, birth data, ids or
per-record rows, only aggregates. Reports from licensed or personal files are written outside
git trees, and the tool refuses to write them inside one.

## Run it on the synthetic example (no data needed)

```bash
cd backend
uv sync
uv run almamesh-eval retrodiction \
  --events ../examples/retrodiction/synthetic_null.yaml --out /tmp/retro-demo
cat /tmp/retro-demo/report.md
```

The synthetic file is made-up natives with random event dates. It must come out null, and it
does. The same run on `examples/retrodiction/events.example.yaml` shows the file format for
your own events (copy it outside the repo first).

## Run it on licensed data you hold yourself

You need your own copy of the Astro-Databank export (`.zip`, under its licence). Keep it
outside this repo. The zip password is read from the environment and never printed:

```bash
export ALMAMESH_ADB_ZIP_PASSWORD=...   # your own download's password; do not paste it into logs
cd backend
uv run almamesh-eval adb-summary --adb ~/data/adb_export.zip          # counts only
uv run almamesh-eval scorecard --adb ~/data/adb_export.zip --split dev --workers 4
```

Every scoring command on an export needs `--split dev`; leaving it out is refused, so the
held-out half cannot be read by omission. If `ALMAMESH_ADB_ZIP_PASSWORD` is unset on macOS the
tool falls back to a Keychain item of the same name; the value is never printed.

If the export is missing the command stops with `refused: ... no such file` and exit code 2.
Nothing here uses the network, and CI never runs it: the tests use fake entries only.
A full run takes minutes to hours depending on `--workers` and `--sample-natives`.

## The held-out half is spent

The natives are split once into a DEV half and a HELD-OUT half, pinned by a digest
(`ADB_SPLIT_DIGEST` in `backend/src/almamesh/retrodiction/split.py`). Exploration uses DEV.
HELD-OUT needs `--release-look`, and the CLI refuses a split that does not reproduce the
digest. `--release-look` is a flag, not a check: the ledger and the pre-registration are the
human half of the rule. The held-out look has been used for (g1) and (i), so any further held-out look needs
a new pre-registration. See [holdout-ledger.md](holdout-ledger.md).

## Where the details are

- Design and pre-registered amendments: `docs/superpowers/specs/2026-10-14-retrodiction-eval-design.md`
- Results (aggregates only): `docs/superpowers/specs/2026-10-14-retrodiction-results.md`
