import app from "./app";
import type { Env } from "./env";
import { probeDueNodes } from "./services/probe";
import { refreshDueSources } from "./services/sources";

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
    // Sequential: refresh and probes share the per-request subrequest budget.
    context.waitUntil((async () => {
      await refreshDueSources(env);
      await probeDueNodes(env);
    })());
  },
} satisfies ExportedHandler<Env>;
