// Adapter registry: dispatch a corridor to the anchor adapter that
// implements its destination protocol. The service uses this as the
// `adapterFor` callback injected into StaticRouteResolver / RegistryRouteResolver,
// so a manifest declaring `protocol: sep6` or `custom:<id>` fails at startup
// instead of at runtime.

import { protocolOf, type Corridor } from "@corridor/manifest";
import type { AnchorAdapter } from "@corridor/adapter-kit";

/** Builds an adapter for a corridor. May throw if the corridor is not supported. */
export type AdapterFactory = (corridor: Corridor) => AnchorAdapter;

export interface AdapterRegistry {
  /** Register a factory for a protocol identifier (e.g. "sep31", "sep6", "custom:my-proto"). */
  register(protocol: string, factory: AdapterFactory): void;
  /** Return true if a factory is registered for the corridor's protocol. */
  has(corridor: Corridor): boolean;
  /** Dispatch to the factory for the corridor's protocol. Throws if unregistered. */
  adapterFor(corridor: Corridor): AnchorAdapter;
}

/**
 * Create an empty adapter registry. Pre-register protocols at the call site:
 *
 *   const adapters = createAdapterRegistry();
 *   adapters.register("sep31", (c) => new Sep31Adapter(c, { sep10 }));
 *   adapters.register("sep6", (c) => new Sep6Adapter(c));
 *
 * The service should validate every loaded corridor against the registry at
 * startup (adapters.has(corridor)) so a misconfigured manifest fails fast.
 */
export function createAdapterRegistry(): AdapterRegistry {
  const factories = new Map<string, AdapterFactory>();

  function protocolForCorridor(corridor: Corridor): string {
    return protocolOf(corridor.dest);
  }

  return {
    register(protocol, factory) {
      if (!factory) {
        throw new Error(`cannot register adapter for "${protocol}": factory is required`);
      }
      factories.set(protocol, factory);
    },

    has(corridor) {
      return factories.has(protocolForCorridor(corridor));
    },

    adapterFor(corridor) {
      const protocol = protocolForCorridor(corridor);
      const factory = factories.get(protocol);
      if (!factory) {
        throw new Error(
          `no adapter registered for protocol "${protocol}" (corridor "${corridor.id}"). ` +
            `Register one via createAdapterRegistry().register("${protocol}", factory).`,
        );
      }
      return factory(corridor);
    },
  };
}
