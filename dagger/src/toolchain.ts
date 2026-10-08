import { createHash } from "node:crypto"
import { ALLOWED_OWNERS, repositoryOwner } from "./repositoryIdentity.js"

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
const TOOLCHAIN_NAME = "almamesh-toolchain"

/**
 * The GHCR repository of the toolchain image under one of our owners. The image
 * follows the repository: before the transfer it is published under hseshadr,
 * after it under gainratio. Any other owner is refused.
 */
export function toolchainRepository(owner: string): string {
  if (!ALLOWED_OWNERS.includes(owner)) {
    throw new Error(`"${owner}" is not an allowed owner; expected one of ${ALLOWED_OWNERS.join(", ")}`)
  }
  return `ghcr.io/${owner}/${TOOLCHAIN_NAME}`
}

/**
 * The owner to publish the image under: the run's `github.repository_owner`,
 * lowercased (GHCR names are lowercase), and only when it is the owner of the
 * run's allow-listed `github.repository`.
 */
export function toolchainImageOwner(repository: string, runOwner: string): string {
  const owner = repositoryOwner(repository)
  if (typeof runOwner !== "string" || runOwner.toLowerCase() !== owner) {
    throw new Error(`run owner "${runOwner}" is not the owner of ${repository}`)
  }
  return owner
}
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
// The gainratio package is private: gates pull it with the run's GITHUB_TOKEN.
export const TOOLCHAIN_IMAGE: string | null =
  "ghcr.io/gainratio/almamesh-toolchain:r-81e517e120c27dea-pw1.63.0@sha256:11352b6f77703c45c8b3e17e669a48364d422cfd421aa3281050b69f17c2cfd2"

// A pin under any allowed owner is accepted, so the hseshadr pin keeps working
// after the transfer until a gainratio-published digest replaces it.
const PINNED = new RegExp(
  `^ghcr\\.io\\/(?:${ALLOWED_OWNERS.join("|")})\\/${TOOLCHAIN_NAME}:(r-[0-9a-f]{16})-pw\\d+\\.\\d+\\.\\d+@sha256:[0-9a-f]{64}$`,
)

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
  if (match === null) throw new Error(`toolchain image must be digest-pinned in ghcr.io/{${ALLOWED_OWNERS.join("|")}}/${TOOLCHAIN_NAME}: ${image}`)
  return match[1] === recipeTag(recipe) ? image : null
}

/** An authenticated pull of the pinned image; `token` is a Dagger Secret in the module. */
export interface ToolchainPull<Token> {
  readonly image: string
  readonly registry: "ghcr.io"
  readonly username: string
  readonly token: Token
}

/**
 * How to pull the pinned toolchain, or null to install inline. The package is
 * private, so a pull needs a registry token; without one (a local `dagger call`)
 * the gates install inline rather than fail on an unauthenticated pull.
 */
export function toolchainPull<Token>(
  image: string | null,
  recipe: ToolchainRecipe,
  token: Token | undefined,
): ToolchainPull<Token> | null {
  const pinned = pinnedToolchain(image, recipe)
  if (pinned === null || token === undefined) return null
  const username = pinned.split("/")[1]
  return { image: pinned, registry: "ghcr.io", username, token }
}
