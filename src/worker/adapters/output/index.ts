import { stringify } from "yaml";
import type { NormalizedNode, OutputProfile, SubscriptionRules, SubscriptionTarget } from "../../../shared/types";
import { compileSafePattern, runSafePattern } from "../../security/regex";
import { decodeBase64Text, encodeBase64Text } from "../input/shared";

// ─── Subscription rules (linear-time regex engine) ───────────────────
//
// Name filters are compiled with the linear-time safe engine from
// security/regex.ts (Thompson NFA + Pike VM), never the runtime's
// backtracking RegExp, so untrusted patterns cannot stall a request.
// Patterns that were stored before stricter validation existed and no
// longer compile are silently skipped (the rule has no effect) instead of
// breaking the subscription.

export function applySubscriptionRules(nodes: NormalizedNode[], rules: SubscriptionRules): NormalizedNode[] {
  const protocols = new Set(rules.protocols?.map((value) => value.toLowerCase()) ?? []);
  const include = rules.includeName ? compileSafePattern(rules.includeName) : undefined;
  const exclude = rules.excludeName ? compileSafePattern(rules.excludeName) : undefined;
  const rename = (rules.rename ?? [])
    .map((rule) => ({ compiled: compileSafePattern(rule.pattern), replacement: rule.replacement.slice(0, 200) }))
    .filter((rule): rule is { compiled: NonNullable<ReturnType<typeof compileSafePattern>>; replacement: string } => rule.compiled !== null);
  const seen = new Set<string>();
  // Compile once per rule instead of once per (node, rule) pair: building a
  // matcher allocates the VM state, which is pure overhead when repeated for
  // thousands of nodes.
  const includeMatcher = include ? runSafePattern(include) : undefined;
  const excludeMatcher = exclude ? runSafePattern(exclude) : undefined;
  const renames = rename.map((rule) => ({ matcher: runSafePattern(rule.compiled), replacement: rule.replacement }));
  const output = nodes.filter((node) => {
    if (!node.enabled || seen.has(node.fingerprint)) return false;
    if (protocols.size > 0 && !protocols.has(node.protocol.toLowerCase())) return false;
    if (includeMatcher && !includeMatcher.test(node.name)) return false;
    if (excludeMatcher && excludeMatcher.test(node.name)) return false;
    seen.add(node.fingerprint);
    return true;
  }).map((node) => {
    let name = node.name;
    for (const rule of renames) {
      name = rule.matcher.replace(name, rule.replacement);
    }
    return { ...node, name, config: { ...node.config, name } };
  });
  const sortBy = rules.sortBy ?? "name";
  output.sort((left, right) => {
    if (sortBy === "protocol") return left.protocol.localeCompare(right.protocol) || left.name.localeCompare(right.name);
    if (sortBy === "source") return (left.sourceId ?? "").localeCompare(right.sourceId ?? "") || left.name.localeCompare(right.name);
    return left.name.localeCompare(right.name, "zh-CN");
  });
  return output;
}

// ─── Duration helpers ─────────────────────────────────────────────────
//
// AnyTLS idle-session timings are expressed differently per target:
//   - sing-box expects a Go-style duration string ("30s") — a bare number
//     is rejected by sing-box 1.14.
//   - Mihomo expects an integer number of seconds — "30s" fails `mihomo -t`
//     with "cannot parse 'idle-session-check-interval' as int".
// These helpers convert between the URI/DB representation and each target.

function durationToSeconds(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/u.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = match[2] === "ms" ? 0.001 : match[2] === "m" ? 60 : match[2] === "h" ? 3600 : 1;
  return Math.max(0, Math.round(amount * multiplier));
}

function singboxDuration(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+(?:\.\d+)?(ms|s|m|h)$/u.test(value.trim())) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value)) + "s";
  return undefined;
}

// ─── Raw URI generation ──────────────────────────────────────────────
//
// Raw output must reflect renames and node-name edits while preserving the
// URI-specific parameters and credentials of the original link. When the
// stored raw URI's embedded name still matches the current node name the
// original URI is returned verbatim (nothing is lost); once the name has
// been changed the URI is regenerated from the normalized config, which
// carries every parameter the parser captured.

function rawUriMatchesName(uri: string, protocol: string, name: string): boolean {
  try {
    if (protocol === "vmess") {
      const payload = JSON.parse(decodeBase64Text(uri.slice(8))) as Record<string, unknown>;
      return payload.ps === name;
    }
    const hashIndex = uri.indexOf("#");
    if (hashIndex < 0) return false;
    return decodeURIComponent(uri.slice(hashIndex + 1)) === name;
  } catch {
    return false;
  }
}

function uriForNode(node: NormalizedNode): string | undefined {
  if (node.rawUri && rawUriMatchesName(node.rawUri, node.protocol, node.name)) return node.rawUri;
  const config = node.config;
  const name = encodeURIComponent(node.name);

  if (node.protocol === "ss" && typeof config.cipher === "string" && typeof config.password === "string") {
    const credentials = encodeBase64Text(config.cipher + ":" + config.password).replace(/=+$/u, "");
    let uri = "ss://" + credentials + "@" + node.server + ":" + node.port;
    const query = new URLSearchParams();
    if (typeof config.plugin === "string") query.set("plugin", config.plugin);
    if (query.size) uri += "?" + query.toString();
    return uri + "#" + name;
  }

  if (node.protocol === "vmess" && typeof config.uuid === "string") {
    const payload: Record<string, string> = {
      v: "2", ps: node.name, add: node.server, port: String(node.port),
      id: config.uuid, aid: String(config.alterId ?? 0),
      net: typeof config.network === "string" ? config.network : "tcp",
      tls: config.tls ? "tls" : "",
      sni: typeof config.servername === "string" ? config.servername : "",
    };
    if (config["ws-opts"] && typeof config["ws-opts"] === "object") {
      const wsOpts = config["ws-opts"] as Record<string, unknown>;
      if (typeof wsOpts.path === "string") payload.path = wsOpts.path;
      if (wsOpts.headers && typeof wsOpts.headers === "object") {
        const headers = wsOpts.headers as Record<string, string>;
        if (headers.Host) payload.host = headers.Host;
      }
    }
    if (typeof config.flow === "string") payload.flow = config.flow;
    if (Array.isArray(config.alpn)) payload.alpn = (config.alpn as string[]).join(",");
    return "vmess://" + encodeBase64Text(JSON.stringify(payload)).replace(/=+$/u, "");
  }

  const credential = node.protocol === "vless" || node.protocol === "tuic" ? config.uuid : config.password;
  if (typeof credential !== "string") return undefined;

  const query = new URLSearchParams();
  // AnyTLS is always TLS — no `security` parameter needed (and the official
  // client rejects unknown ones); trojan/hysteria2/tuic imply TLS as well.
  if (config.tls && node.protocol !== "anytls" && node.protocol !== "trojan" && node.protocol !== "hysteria2" && node.protocol !== "tuic") query.set("security", "tls");
  if (typeof config.sni === "string") query.set("sni", config.sni);
  if (typeof config.network === "string" && config.network !== "tcp") query.set("type", config.network);
  if (typeof config.flow === "string") query.set("flow", config.flow);
  if (Array.isArray(config.alpn)) query.set("alpn", (config.alpn as string[]).join(","));
  if (config["skip-cert-verify"]) query.set("allowInsecure", "1");
  if (config["ws-opts"] && typeof config["ws-opts"] === "object") {
    const wsOpts = config["ws-opts"] as Record<string, unknown>;
    if (typeof wsOpts.path === "string") query.set("path", wsOpts.path);
    if (wsOpts.headers && typeof wsOpts.headers === "object") {
      const headers = wsOpts.headers as Record<string, string>;
      if (headers.Host) query.set("host", headers.Host);
    }
  }
  // Hysteria2 obfs
  if (node.protocol === "hysteria2") {
    if (typeof config.obfs === "string") query.set("obfs", config.obfs);
    if (typeof config["obfs-password"] === "string") query.set("obfs-password", config["obfs-password"]);
    if (typeof config.up === "string") query.set("up", config.up);
    if (typeof config.down === "string") query.set("down", config.down);
  }
  // TUIC specific
  if (node.protocol === "tuic" && typeof config["congestion-controller"] === "string") {
    query.set("congestion_control", config["congestion-controller"]);
  }

  const password = node.protocol === "tuic" && typeof config.password === "string" ? ":" + encodeURIComponent(config.password) : "";
  // AnyTLS specific parameters
  if (node.protocol === "anytls") {
    if (typeof config["client-fingerprint"] === "string") query.set("client-fingerprint", config["client-fingerprint"]);
    if (typeof config["idle-session-check-interval"] === "string") query.set("idle-session-check-interval", config["idle-session-check-interval"]);
    if (typeof config["idle-session-timeout"] === "string") query.set("idle-session-timeout", config["idle-session-timeout"]);
    if (typeof config["min-idle-session"] === "number") query.set("min-idle-session", String(config["min-idle-session"]));
  }
  return node.protocol + "://" + encodeURIComponent(credential) + password + "@" + node.server + ":" + node.port + (query.size ? "?" + query.toString() : "") + "#" + name;
}

// ─── Mihomo / Clash Meta full config ─────────────────────────────────
//
// Target: Mihomo ≥ 1.19 (validated with `mihomo -t` on 1.19.30).

function mihomoProxy(node: NormalizedNode): Record<string, unknown> {
  const proxy: Record<string, unknown> = { ...node.config, name: node.name, type: node.protocol, server: node.server, port: node.port };
  if (node.protocol === "anytls") {
    // AnyTLS is TLS-only: emit it explicitly and map the idle-session
    // timings to the integer-seconds form Mihomo's parser requires.
    proxy.tls = true;
    const check = durationToSeconds(proxy["idle-session-check-interval"]);
    const timeout = durationToSeconds(proxy["idle-session-timeout"]);
    if (check !== undefined) proxy["idle-session-check-interval"] = check;
    if (timeout !== undefined) proxy["idle-session-timeout"] = timeout;
  }
  return proxy;
}

// ─── Remote rule sets ───────────────────────────────────────────────
//
// The worker only emits *references*: the client downloads the rule sets
// itself and refreshes them on `interval`, so routing and ad-blocking follow
// upstream without redeploying. Two presets are offered; both publish
// Mihomo (.mrs) and sing-box (.srs) flavours from the same paths.

// MetaCubeX/meta-rules-dat publishes the two flavours on separate *branches*
// (`meta` → .mrs for Mihomo, `sing` → .srs for sing-box); the files live under
// `geo/geosite/`. Verified against the live repository.
const DEFAULT_RULE_SET_BASES: Record<"mihomo" | "singbox", string> = {
  mihomo: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta",
  singbox: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing",
};

/** Custom preset expects `baseUrl` to already include the branch. */
function ruleSetUrl(kind: "mihomo" | "singbox", profile: OutputProfile | undefined, file: string): string {
  const base = profile?.preset === "custom" && profile.baseUrl
    ? profile.baseUrl.replace(/\/+$/u, "")
    : DEFAULT_RULE_SET_BASES[kind];
  return base + "/geo/geosite/" + file;
}

function buildMihomoConfig(nodes: NormalizedNode[], profile?: OutputProfile): Record<string, unknown> {
  const proxies = nodes.map(mihomoProxy);
  const proxyNames = proxies.map((p) => p.name as string);

  // Nodes only: the client owns the policy (own proxy-groups/rules or a
  // local preprocessor).
  if (profile?.mode === "minimal") return { proxies };

  const proxyGroups = [
    { name: "🚀 节点选择", type: "select", proxies: ["♻️ 自动选择", ...proxyNames] },
    { name: "♻️ 自动选择", type: "url-test", proxies: proxyNames, url: "https://www.gstatic.com/generate_204", interval: 300, tolerance: 50 },
    { name: "🌍 国外媒体", type: "select", proxies: ["🚀 节点选择", "♻️ 自动选择", ...proxyNames] },
    { name: "📲 Telegram", type: "select", proxies: ["🚀 节点选择", "♻️ 自动选择", ...proxyNames] },
    { name: "🍎 Apple", type: "select", proxies: ["🚀 节点选择", "DIRECT"] },
    { name: "🤖 AI", type: "select", proxies: ["🚀 节点选择", "♻️ 自动选择", ...proxyNames] },
    { name: "🐟 漏网之鱼", type: "select", proxies: ["🚀 节点选择", "DIRECT"] },
  ];

  const rules = [
    "DOMAIN-SUFFIX,openai.com,🤖 AI",
    "DOMAIN-SUFFIX,anthropic.com,🤖 AI",
    "DOMAIN-SUFFIX,claude.ai,🤖 AI",
    "DOMAIN-SUFFIX,gemini.google.com,🤖 AI",
    "DOMAIN-SUFFIX,copilot.microsoft.com,🤖 AI",
    "DOMAIN-KEYword,telegram,📲 Telegram",
    "DOMAIN-SUFFIX,t.me,📲 Telegram",
    "DOMAIN-SUFFIX,telegra.ph,📲 Telegram",
    "DOMAIN-SUFFIX,netflix.com,🌍 国外媒体",
    "DOMAIN-SUFFIX,nflxvideo.net,🌍 国外媒体",
    "DOMAIN-SUFFIX,youtube.com,🌍 国外媒体",
    "DOMAIN-SUFFIX,googlevideo.com,🌍 国外媒体",
    "DOMAIN-SUFFIX,ggpht.com,🌍 国外媒体",
    "DOMAIN-SUFFIX,apple.com,🍎 Apple",
    "DOMAIN-SUFFIX,icloud.com,🍎 Apple",
    "GEOIP,CN,DIRECT",
    "MATCH,🐟 漏网之鱼",
  ];

  if (profile?.mode === "remote") {
    const interval = Math.max(3_600, Math.min(profile.updateInterval ?? 86_400, 2_592_000));
    const provider = (name: string, behaviour: string, file: string) => ({
      [name]: {
        type: "http",
        behavior: behaviour,
        url: ruleSetUrl("mihomo", profile, file),
        path: "./ruleset/" + file.replace(/\.mrs$/u, ""),
        interval,
      },
    });
    // Order matters: ads are rejected first, then the special-interest
    // categories, then geography, then the catch-all.
    const remoteRules = [
      ...(profile.adBlock ? ["RULE-SET,category-ads-all,REJECT"] : []),
      "RULE-SET,category-ai-!cn,🤖 AI",
      "RULE-SET,telegram,📲 Telegram",
      "RULE-SET,netflix,🌍 国外媒体",
      "RULE-SET,youtube,🌍 国外媒体",
      "RULE-SET,apple,🍎 Apple",
      "RULE-SET,cn,DIRECT",
      "MATCH,🐟 漏网之鱼",
    ];
    return {
      proxies,
      "proxy-groups": proxyGroups,
      "rule-providers": Object.assign(
        {},
        ...(profile.adBlock ? [provider("category-ads-all", "domain", "category-ads-all.mrs")] : []),
        provider("category-ai-!cn", "domain", "category-ai-!cn.mrs"),
        provider("telegram", "domain", "telegram.mrs"),
        provider("netflix", "domain", "netflix.mrs"),
        provider("youtube", "domain", "youtube.mrs"),
        provider("apple", "domain", "apple.mrs"),
        provider("cn", "domain", "cn.mrs"),
      ),
      rules: remoteRules,
    };
  }

  return { proxies, "proxy-groups": proxyGroups, rules };
}

// ─── Sing-box JSON ───────────────────────────────────────────────────
//
// Target: sing-box 1.14.x (validated with `sing-box check` on 1.14.0).
// Removed constructs are NOT emitted: the `dns` outbound (removed 1.13),
// legacy DNS server objects (removed 1.14 — servers use `type` + `server`),
// `geoip` route/DNS rules (removed 1.12 — replaced by `ip_is_private` /
// `ip_cidr`), and implicit domain resolution (1.14 requires an explicit
// `route.default_domain_resolver`).

const ALWAYS_TLS_PROTOCOLS = new Set(["trojan", "hysteria2", "tuic", "anytls"]);

function singboxTls(node: NormalizedNode): Record<string, unknown> | undefined {
  const config = node.config;
  if (!config.tls && !ALWAYS_TLS_PROTOCOLS.has(node.protocol)) return undefined;
  const tls: Record<string, unknown> = {
    enabled: true,
    server_name: config.sni ?? config.servername ?? node.server,
    insecure: Boolean(config["skip-cert-verify"]),
    alpn: Array.isArray(config.alpn) ? config.alpn : undefined,
  };
  if (node.protocol === "anytls" && typeof config["client-fingerprint"] === "string") {
    tls.utls = { enabled: true, fingerprint: config["client-fingerprint"] };
  }
  return tls;
}

function buildSingboxConfig(nodes: NormalizedNode[], profile?: OutputProfile): Record<string, unknown> {
  const outbounds: Record<string, unknown>[] = [];
  const tagMap: Array<{ tag: string; protocol: string }> = [];

  for (const node of nodes) {
    const tag = node.name;
    const config = node.config;
    const outbound: Record<string, unknown> = { tag, server: node.server, server_port: node.port };

    if (node.protocol === "ss") {
      outbound.type = "shadowsocks";
      outbound.method = config.cipher;
      outbound.password = config.password;
    } else if (node.protocol === "vmess") {
      outbound.type = "vmess";
      outbound.uuid = config.uuid;
      outbound.security = config.cipher ?? "auto";
      if (config.alterId && Number(config.alterId) > 0) outbound.alter_id = Number(config.alterId);
    } else if (node.protocol === "vless") {
      outbound.type = "vless";
      outbound.uuid = config.uuid;
      if (config.flow) outbound.flow = config.flow;
    } else if (node.protocol === "trojan") {
      outbound.type = "trojan";
      outbound.password = config.password;
    } else if (node.protocol === "hysteria2") {
      outbound.type = "hysteria2";
      outbound.password = config.password;
      if (config.obfs) outbound.obfs = { type: config.obfs, password: config["obfs-password"] };
      if (config.up) outbound.up_mbps = Number(config.up);
      if (config.down) outbound.down_mbps = Number(config.down);
    } else if (node.protocol === "tuic") {
      outbound.type = "tuic";
      outbound.uuid = config.uuid;
      outbound.password = config.password;
      if (config["congestion-controller"]) outbound.congestion_control = config["congestion-controller"];
    } else if (node.protocol === "anytls") {
      outbound.type = "anytls";
      outbound.password = config.password;
      const check = singboxDuration(config["idle-session-check-interval"]);
      const timeout = singboxDuration(config["idle-session-timeout"]);
      if (check) outbound.idle_session_check_interval = check;
      if (timeout) outbound.idle_session_timeout = timeout;
      if (typeof config["min-idle-session"] === "number") outbound.min_idle_session = config["min-idle-session"];
    } else {
      continue;
    }

    const tls = singboxTls(node);
    if (tls) outbound.tls = tls;
    if (config.network === "ws" && config["ws-opts"]) {
      const wsOpts = config["ws-opts"] as Record<string, unknown>;
      outbound.transport = {
        type: "ws",
        path: wsOpts.path ?? "/",
        headers: wsOpts.headers ?? {},
      };
    } else if (config.network === "grpc" && config["grpc-opts"]) {
      const grpcOpts = config["grpc-opts"] as Record<string, unknown>;
      outbound.transport = { type: "grpc", service_name: grpcOpts["grpc-service-name"] ?? "" };
    }

    tagMap.push({ tag, protocol: node.protocol });
    outbounds.push(outbound);
  }

  const proxyTags = tagMap.map((t) => t.tag);

  if (proxyTags.length > 0) {
    outbounds.push({ type: "selector", tag: "🚀 节点选择", outbounds: ["♻️ 自动选择", ...proxyTags], default: "♻️ 自动选择" });
    outbounds.push({ type: "urltest", tag: "♻️ 自动选择", outbounds: proxyTags, url: "https://www.gstatic.com/generate_204", interval: "5m", tolerance: 50 });
  }
  outbounds.push({ type: "direct", tag: "DIRECT" });

  const dnsServers: Record<string, unknown>[] = [];
  if (proxyTags.length > 0) {
    dnsServers.push({ type: "https", tag: "google", server: "dns.google", server_port: 443, detour: "🚀 节点选择" });
  }
  dnsServers.push({ type: "udp", tag: "local", server: "223.5.5.5", detour: "DIRECT" });

  const routeRules: Record<string, unknown>[] = [
    { ip_is_private: true, outbound: "DIRECT" },
  ];

  // Nodes only: whatever consumes this supplies its own policy.
  if (profile?.mode === "minimal") {
    return {
      log: { level: "info" },
      outbounds: proxyTags.length > 0 ? [...outbounds.filter((o) => o.type !== "selector" && o.type !== "urltest")] : outbounds,
    };
  }

  if (profile?.mode === "remote") {
    // sing-box downloads rule sets itself and refreshes them; the worker
    // only names them.
    const setTag = (name: string) => "rs-" + name;
    const sets: Record<string, unknown>[] = [
      { tag: setTag("ai"), type: "remote", format: "binary", url: ruleSetUrl("singbox", profile, "category-ai-!cn.srs") },
      { tag: setTag("telegram"), type: "remote", format: "binary", url: ruleSetUrl("singbox", profile, "telegram.srs") },
      { tag: setTag("media"), type: "remote", format: "binary", url: ruleSetUrl("singbox", profile, "netflix.srs") },
      { tag: setTag("cn"), type: "remote", format: "binary", url: ruleSetUrl("singbox", profile, "cn.srs") },
    ];
    if (profile.adBlock) {
      sets.unshift({ tag: setTag("ads"), type: "remote", format: "binary", url: ruleSetUrl("singbox", profile, "category-ads-all.srs") });
    }
    routeRules.push(
      ...(profile.adBlock ? [{ rule_set: setTag("ads"), action: "reject" } as Record<string, unknown>] : []),
      { rule_set: setTag("cn"), action: "route", outbound: "DIRECT" },
      { rule_set: setTag("ai"), action: "route", outbound: "🚀 节点选择" },
      { rule_set: setTag("telegram"), action: "route", outbound: "🚀 节点选择" },
      { rule_set: setTag("media"), action: "route", outbound: "🚀 节点选择" },
    );
    return {
      log: { level: "info" },
      dns: {
        servers: dnsServers,
        rules: [
          { domain_suffix: [".cn"], server: "local" },
          { query_type: ["A", "AAAA"], server: proxyTags.length > 0 ? "google" : "local" },
        ],
      },
      outbounds,
      route: {
        default_domain_resolver: { server: proxyTags.length > 0 ? "google" : "local" },
        rule_set: sets,
        rules: routeRules,
        final: proxyTags.length > 0 ? "🚀 节点选择" : "DIRECT",
      },
    };
  }

  if (proxyTags.length > 0) {
    routeRules.push(
      { domain_suffix: ["openai.com", "anthropic.com", "claude.ai", "gemini.google.com"], outbound: "🚀 节点选择" },
      { domain_suffix: ["t.me", "telegram.org"], outbound: "🚀 节点选择" },
      { domain_suffix: ["netflix.com", "nflxvideo.net", "youtube.com", "googlevideo.com"], outbound: "🚀 节点选择" },
    );
  }

  return {
    log: { level: "info" },
    dns: {
      servers: dnsServers,
      rules: [
        { domain_suffix: [".cn"], server: "local" },
        { query_type: ["A", "AAAA"], server: proxyTags.length > 0 ? "google" : "local" },
      ],
    },
    outbounds,
    route: {
      default_domain_resolver: { server: proxyTags.length > 0 ? "google" : "local" },
      rules: routeRules,
      final: proxyTags.length > 0 ? "🚀 节点选择" : "DIRECT",
    },
  };
}

// ─── Main renderer ───────────────────────────────────────────────────

export function renderSubscription(nodes: NormalizedNode[], target: SubscriptionTarget, profile?: OutputProfile): { body: string; contentType: string; extension: string } {
  // JSON targets are emitted compact: pretty-printing inflated large
  // subscriptions by roughly a third for no client benefit, and the bytes
  // are counted against the response, the KV cache entry and the client's
  // download every single time.
  if (target === "json") {
    return { body: JSON.stringify({ version: 1, nodes }), contentType: "application/json; charset=utf-8", extension: "json" };
  }
  if (target === "mihomo") {
    return { body: stringify(buildMihomoConfig(nodes, profile), { lineWidth: 0 }), contentType: "application/yaml; charset=utf-8", extension: "yaml" };
  }
  if (target === "singbox") {
    return { body: JSON.stringify(buildSingboxConfig(nodes, profile)), contentType: "application/json; charset=utf-8", extension: "json" };
  }
  // raw
  const uris = nodes.map(uriForNode).filter((value): value is string => Boolean(value));
  return { body: encodeBase64Text(uris.join("\n")), contentType: "text/plain; charset=utf-8", extension: "txt" };
}
