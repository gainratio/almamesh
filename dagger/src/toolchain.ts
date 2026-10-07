import { createHash } from "node:crypto"

// The prebuilt browser toolchain. Every browser gate used to spend ~2 minutes on
// the same apt install and Playwright browser download; the image bakes both in.
// `toolchain-image.yml` publishes it from main (`dagger call publish-toolchain`)
// under a tag that names this recipe and the locked Playwright version.
//
// Fallback: with TOOLCHAIN_IMAGE = null, or a pin built from another recipe, the
// gates install everything inline exactly as before. Both paths run the same
// apt list and the same `playwright install --with-deps`, so the result is the same.

export const UV_IMAGE =
  "ghcr.io/astral-sh/uv:0.12.1-python3.13-trixie-slim@sha256:8db423175bfff42bd1c81f77280bc92f10ef9cf03161803bd5cb6e15d86c3d10"
export const BUN_IMAGE =
  "oven/bun:1.3.5@sha256:e90cdbaf9ccdb3d4bd693aa335c3310a6004286a880f62f79b18f9b1312a8ec3"
export const TOOLCHAIN_REPOSITORY = "ghcr.io/hseshadr/almamesh-toolchain"
// The file inside the image that records which Playwright built its browsers.
export const TOOLCHAIN_PLAYWRIGHT_FILE = "/opt/almamesh-toolchain/playwright-version"

export interface ToolchainRecipe {
  readonly base: string
  readonly bun: string
  readonly apt: readonly string[]
  readonly browsers: readonly string[]
}

export const TOOLCHAIN_RECIPE: ToolchainRecipe = {
  base: UV_IMAGE,
  bun: BUN_IMAGE,
  apt: ["build-essential", "ca-certificates", "curl", "git", "node-gyp", "nodejs", "openssl", "poppler-utils"],
  browsers: ["chromium", "firefox", "webkit"],
}

// Digest-pinned image built by toolchain-image.yml, or null to install inline.
export const TOOLCHAIN_IMAGE: string | null =
  "ghcr.io/hseshadr/almamesh-toolchain:r-81e517e120c27dea-pw1.63.0@sha256:ddccce732634082393bb427db3659a0c98cd172562be7786b4bab9c7244d3c99"

const PINNED = /^ghcr\.io\/hseshadr\/almamesh-toolchain:(r-[0-9a-f]{16})-pw\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/

/** The exact Playwright version frontend/bun.lock resolves. */
export function playwrightVersion(lock: string): string {
  const match = /"playwright-core@(\d+\.\d+\.\d+)"/.exec(lock)
  if (match === null) throw new Error("frontend/bun.lock resolves no playwright-core version")
  return match[1]
}

/** `r-<16 hex>`: changes whenever any input of the recipe changes. */
export function recipeTag(recipe: ToolchainRecipe): string {
  const digest = createHash("sha256").update(JSON.stringify(recipe)).digest("hex")
  return `r-${digest.slice(0, 16)}`
}

export function toolchainTag(recipe: ToolchainRecipe, playwright: string): string {
  return `${recipeTag(recipe)}-pw${playwright}`
}

/** The pinned image when it was built from this recipe, else null (install inline). */
export function pinnedToolchain(image: string | null, recipe: ToolchainRecipe): string | null {
  if (image === null) return null
  const match = PINNED.exec(image)
  if (match === null) throw new Error(`toolchain image must be digest-pinned in ${TOOLCHAIN_REPOSITORY}: ${image}`)
  return match[1] === recipeTag(recipe) ? image : null
}
