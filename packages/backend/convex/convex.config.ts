import { defineApp } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";

const app = defineApp();
// Every transaction the relayer sends goes through this pool one at a time, so two at once can't
// take the same nonce.
app.use(workpool, { name: "relayer" });

export default app;
