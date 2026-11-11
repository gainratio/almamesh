import { expectTypeOf, it } from "vitest";

import type {
  ChartEngine,
  DayPanchangMark,
  MoonEnds,
  MoonMark,
  MoonWindow,
  MoonWindowDayInput,
  MoonWindowEvent,
  MoonWindowInput,
  MoonWindowNatalMoonInput,
  ShashtiamsaAmsa,
  VargaDetailInput,
  VargaDetailPlacement,
  VargaDetailPlanetInput,
  VargaDetailResult,
  VargaLagnaSensitivity,
} from "../index";
import type * as TypesBarrel from "../types";

// Consumers import these from "@almamesh/browser" and "@almamesh/browser/types";
// tsc fails this file if either barrel stops exporting any of them.
it("exports moon window daily marks and varga detail types from both barrels", () => {
  expectTypeOf<ChartEngine["computeMoonWindow"]>().toEqualTypeOf<
    (input: MoonWindowInput) => Promise<MoonWindow>
  >();
  expectTypeOf<ChartEngine["computeVargaDetail"]>().toEqualTypeOf<
    (input: VargaDetailInput) => Promise<VargaDetailResult>
  >();
  expectTypeOf<TypesBarrel.ChartEngine["computeVargaDetail"]>().toEqualTypeOf<
    (input: VargaDetailInput) => Promise<VargaDetailResult>
  >();
  expectTypeOf<MoonWindow["at_place"]>().toEqualTypeOf<MoonEnds>();
  expectTypeOf<MoonWindow["days"]>().toEqualTypeOf<readonly DayPanchangMark[] | undefined>();
  expectTypeOf<MoonEnds["at_start"]>().toEqualTypeOf<MoonMark>();
  expectTypeOf<MoonWindowInput["event"]>().toEqualTypeOf<MoonWindowEvent | undefined>();
  expectTypeOf<MoonWindowInput["days"]>().toEqualTypeOf<
    readonly MoonWindowDayInput[] | undefined
  >();
  expectTypeOf<MoonWindowInput["natalMoon"]>().toEqualTypeOf<
    MoonWindowNatalMoonInput | undefined
  >();
  expectTypeOf<MoonMark["paksha"]>().toEqualTypeOf<"shukla" | "krishna">();
  expectTypeOf<VargaDetailInput["planets"]>().toEqualTypeOf<
    Readonly<Record<string, VargaDetailPlanetInput>>
  >();
  expectTypeOf<VargaDetailResult["sensitivity"]>().toEqualTypeOf<VargaLagnaSensitivity>();
  expectTypeOf<VargaDetailResult["lagna_shashtiamsa"]>().toEqualTypeOf<ShashtiamsaAmsa | null>();
  expectTypeOf<VargaDetailResult["placements"]>().toEqualTypeOf<
    Readonly<Record<string, VargaDetailPlacement>>
  >();
});
