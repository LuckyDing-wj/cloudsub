export type SubscriptionTarget = "raw" | "mihomo" | "singbox" | "json";

export type SourceKind = "subscription" | "standalone";

export interface NormalizedNode {
  id?: string;
  sourceId?: string;
  name: string;
  protocol: string;
  server: string;
  port: number;
  config: Record<string, unknown>;
  enabled: boolean;
  fingerprint: string;
  rawUri?: string;
}

export interface SubscriptionRules {
  protocols?: string[];
  includeName?: string;
  excludeName?: string;
  sortBy?: "name" | "protocol" | "source";
  rename?: Array<{ pattern: string; replacement: string }>;
  output?: OutputProfile;
}

/**
 * How the rendered config is shaped.
 *
 * `builtin` keeps the rules that ship with this worker (small, offline,
 * fixed). `remote` emits references to an upstream rule set instead — the
 * client downloads and refreshes them on its own schedule, so routing and
 * ad-blocking stay current without a code change or redeploy. `minimal`
 * emits nodes only, for clients that already carry their own policy.
 */
export interface OutputProfile {
  mode?: "builtin" | "remote" | "minimal";
  /**
   * Rule-set preset.
   * - `metacubex`    — both kernels, daily updates
   * - `blackmatrix7` — largest Mihomo lists (Mihomo only; sing-box falls back
   *                    to MetaCubeX)
   * - `senshinya`    — largest sing-box list set (sing-box only; Mihomo falls
   *                    back to MetaCubeX)
   * - `custom`       — a meta-rules-dat-compatible repository
   */
  preset?: "metacubex" | "blackmatrix7" | "senshinya" | "custom";
  /**
   * Rule-set root for the `custom` preset, including the branch, e.g.
   * `https://raw.githubusercontent.com/<owner>/<repo>/<branch>`.
   * `/geo/geosite/<name>.mrs|.srs` is appended to it.
   */
  baseUrl?: string;
  /** Block advertising/tracker domains first. */
  adBlock?: boolean;
  /** Client-side refresh interval for remote rule sets, in seconds. */
  updateInterval?: number;
}
