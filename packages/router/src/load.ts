// loadResolver — inject a RouteResolver module at deploy time.
//
// The open repo ships the RouteResolver interface (./index) and two open
// resolvers. The closed half of the plan is that an operator supplies a private
// resolver at deploy time WITHOUT forking this repo: a module on disk (or an
// installed package) that satisfies the contract below, named in config, is the
// entire integration.
//
// The contract a module must satisfy:
//
//   export const apiVersion = ROUTE_RESOLVER_API_VERSION;
//   export default function createResolver(ctx, options) {
//     return { async resolve(intent, corridor) { ... } };
//   }
//
// Loading is deliberately boring: dynamic import() of an absolute or
// cwd-relative filesystem path, or of an installed package name. NEVER a URL.
// Code fetched over the network at boot on an operator's say-so is a
// supply-chain hole, and every legitimate need for one is covered by getting
// the file onto the machine first — a resolver handles real money, so the
// provenance of its code is not a detail to leave to an http client.

import { existsSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AnchorAdapter } from "@corridor/adapter-kit";
import type { Corridor } from "@corridor/manifest";
import type { RouteResolver } from "./index";

/**
 * The version of the `(ctx, options) => RouteResolver` factory contract this
 * loader implements. A module declares it so a loader upgrade and a module
 * upgrade can never silently disagree about what the factory signature means.
 */
export const ROUTE_RESOLVER_API_VERSION = 1;

export interface LoadResolverSpec {
  /**
   * Where the resolver lives: a filesystem path (absolute, or `./...` relative
   * to the current working directory) or the name of an installed package.
   * URLs of any scheme are refused — see the file header.
   */
  readonly module: string;
  /** Opaque options handed to the module's factory as its second argument. */
  readonly options?: unknown;
}

/** What the loader gives the factory beyond options: the adapter seam. */
export interface LoadResolverCtx {
  readonly adapterFor: (corridor: Corridor) => AnchorAdapter;
}

/** A module was named but could not be turned into a RouteResolver. */
export class ResolverLoadError extends Error {
  constructor(
    readonly spec: string,
    message: string,
  ) {
    super(`resolver module "${spec}": ${message}`);
    this.name = "ResolverLoadError";
  }
}

/** `scheme://...` — a URL of any scheme. Paths (`C:\x`, `./x`, `/x`) never match. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Decide what a spec points at: a path stays a path, a package name stays a
 * package name. The filesystem probe exists so `examples/resolvers/x.ts` (no
 * leading `./`) works the way writers of JSON env vars expect instead of being
 * resolved as a package root that does not exist.
 */
function resolveSpecifier(id: string): string {
  if (id.startsWith(".") || isAbsolute(id)) {
    return resolvePath(process.cwd(), id);
  }
  const local = resolvePath(process.cwd(), id);
  if (existsSync(local)) return local;
  return id;
}

/**
 * Load a RouteResolver from `spec.module`, failing closed at every step:
 * a missing module, a wrong `apiVersion`, a missing default factory, a factory
 * that throws, and a factory that does not return something with `.resolve`
 * are each their own named error. A deploy that points at a resolver that is
 * not there must stop the boot, not fall through to a weaker one.
 */
export async function loadResolver(
  spec: LoadResolverSpec,
  ctx: LoadResolverCtx,
): Promise<RouteResolver> {
  const id = spec.module;
  if (typeof id !== "string" || id.length === 0) {
    throw new ResolverLoadError(String(id), "module must be a non-empty path or package name");
  }
  if (URL_SCHEME.test(id) || id.startsWith("file:")) {
    throw new ResolverLoadError(
      id,
      "URLs are not loadable — pass a filesystem path or an installed package name",
    );
  }

  const target = resolveSpecifier(id);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(target)) as Record<string, unknown>;
  } catch (cause) {
    throw new ResolverLoadError(
      id,
      `could not be loaded (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  const apiVersion = mod.apiVersion;
  if (apiVersion !== ROUTE_RESOLVER_API_VERSION) {
    throw new ResolverLoadError(
      id,
      `declares apiVersion ${String(apiVersion)}, expected ${ROUTE_RESOLVER_API_VERSION}`,
    );
  }

  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new ResolverLoadError(
      id,
      `must default-export a factory (ctx, options) => RouteResolver (found ${typeof factory})`,
    );
  }

  let produced: unknown;
  try {
    produced = await (
      factory as (ctx: LoadResolverCtx, options: unknown) => unknown | Promise<unknown>
    )(ctx, spec.options);
  } catch (cause) {
    throw new ResolverLoadError(
      id,
      `factory threw (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  if (
    typeof produced !== "object" ||
    produced === null ||
    typeof (produced as { resolve?: unknown }).resolve !== "function"
  ) {
    throw new ResolverLoadError(
      id,
      "factory did not return a RouteResolver (no resolve function)",
    );
  }
  return produced as RouteResolver;
}
