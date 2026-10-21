import { Hono } from "hono";
import type { AppEnv, Env } from "./types";
import { HttpError } from "./types";
import { deviceRoutes } from "./routes/device";
import { apiRoutes } from "./routes/api";
import { adminRoutes, adminAuth } from "./routes/admin";
import { runDeliveries } from "./delivery";

const app = new Hono<AppEnv>();

app.get("/", (c) => c.json({ message: "MS of ADMS API" }));
app.get("/health", (c) => c.json({ ok: true }));

// Admin UI files live in public/admin and are only served after admin auth.
app.get("/admin", (c) => c.redirect("/admin/"));
app.use("/admin/*", adminAuth);
app.get("/admin/*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.route("/api/admin", adminRoutes);
app.route("/api/v1", apiRoutes);
app.route("/", deviceRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((error, c) => {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
  console.error("Unhandled error:", error);
  return c.json({ error: "Internal error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDeliveries(env));
  },
} satisfies ExportedHandler<Env>;
