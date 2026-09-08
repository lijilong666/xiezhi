/**
 * Provider resilience: a consecutive-failure circuit breaker per provider
 * plus a one-shot cross-provider degradation retry. When a provider trips
 * (threshold consecutive failures), its routes degrade immediately to the
 * configured fallback; any success resets the count. All state is
 * per-review — nothing persists across runs.
 * @module xiezhi/resilience
 */

import type { ModelRoute } from './roles.ts'

export interface DegradationPolicy {
  /** Consecutive provider failures before routes degrade. */
  readonly threshold: number
  /** The cheaper cross-provider route degraded spawns fall back to. */
  readonly fallback: ModelRoute
}

export class ProviderBreaker {
  private readonly failures = new Map<string, number>()

  constructor(readonly policy: DegradationPolicy) {}

  /** Record one provider outcome; success resets the failure count. */
  record(provider: string, ok: boolean): void {
    if (ok) this.failures.delete(provider)
    else this.failures.set(provider, (this.failures.get(provider) ?? 0) + 1)
  }

  tripped(provider: string): boolean {
    return (this.failures.get(provider) ?? 0) >= this.policy.threshold
  }

  /** Providers currently degraded, for the report. */
  trippedProviders(): readonly string[] {
    return [...this.failures.keys()].filter(provider => this.tripped(provider))
  }

  /**
   * Resolve the route a spawn should use: the tripped provider's primary
   * degrades to the fallback; an already-fallback provider never degrades
   * to itself.
   */
  routeFor(primary: ModelRoute | undefined): { route: ModelRoute | undefined, degraded: boolean } {
    if (primary === undefined) return { route: undefined, degraded: false }
    if (primary.provider !== this.policy.fallback.provider && this.tripped(primary.provider)) {
      return { route: this.policy.fallback, degraded: true }
    }
    return { route: primary, degraded: false }
  }

  /** A different-provider fallback for retrying one failed spawn, if any. */
  retryRoute(primary: ModelRoute | undefined): ModelRoute | undefined {
    if (primary === undefined || primary.provider === this.policy.fallback.provider) return undefined
    return this.policy.fallback
  }
}
