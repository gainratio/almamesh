import { expectTypeOf, it } from "vitest";

import type {
  ChartEngine,
  MoonEnds,
  MoonMark,
  MoonWindow,
  MoonWindowEvent,
  MoonWindowInput,
} from "../index";

// Consumers import these from "@almamesh/browser"; tsc fails this file if the
// barrel stops exporting any of them.
it("exports the moon window types from the package barrel", () => {
  expectTypeOf<ChartEngine["computeMoonWindow"]>().toEqualTypeOf<
    (input: MoonWindowInput) => Promise<MoonWindow>
  >();
  expectTypeOf<MoonWindow["at_place"]>().toEqualTypeOf<MoonEnds>();
  expectTypeOf<MoonEnds["at_start"]>().toEqualTypeOf<MoonMark>();
  expectTypeOf<MoonWindowInput["event"]>().toEqualTypeOf<MoonWindowEvent | undefined>();
  expectTypeOf<MoonMark["paksha"]>().toEqualTypeOf<"shukla" | "krishna">();
});
