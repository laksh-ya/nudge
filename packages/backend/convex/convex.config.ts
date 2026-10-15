import { defineApp } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";

const app = defineApp();
// One queue per sending key, so two sends can't take the same nonce (see lib/relayer.ts): the
// guardian relayer, up to three extra relayer lanes, and a parallel pool for agent keys.
app.use(workpool, { name: "relayer" });
app.use(workpool, { name: "lane1" });
app.use(workpool, { name: "lane2" });
app.use(workpool, { name: "lane3" });
app.use(workpool, { name: "agents" });

export default app;
