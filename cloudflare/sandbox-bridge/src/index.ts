/**
 * Agent Díaz V2 Cloudflare Sandbox bridge.
 *
 * The route implementation comes from the stable @cloudflare/sandbox bridge.
 * This repo owns the container image and Worker bindings so the app, shell,
 * browser automation, and R2 persistence all meet at one sandbox boundary.
 */
import { bridge } from "@cloudflare/sandbox/bridge";

export { Sandbox } from "@cloudflare/sandbox";
export { WarmPool } from "@cloudflare/sandbox/bridge";

export default bridge({
  async fetch(
    _request: Request,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    return new Response("Agent Diaz sandbox bridge OK");
  },
  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Warm pool is deliberately disabled in wrangler.jsonc by default.
  },
});
