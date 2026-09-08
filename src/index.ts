import { createApp } from "./app";
import { classifyWith } from "./classifier";
import { config } from "./config";
import { openDb } from "./db";
import { fakeModel, openRouterModel } from "./model";
import { TicketRepo } from "./tickets";
import { Worker } from "./worker";

const db = openDb(config.dbPath);
const repo = new TicketRepo(db);

const { apiKey, ...openRouter } = config.openRouter;
const model = apiKey ? openRouterModel({ apiKey, ...openRouter }) : fakeModel();
console.log(`model: ${apiKey ? `openrouter/${openRouter.model}` : "fake"}`);

const requeued = repo.requeueInFlight();
if (requeued) console.log(`requeued ${requeued} ticket(s) left in flight by the previous run`);

const worker = new Worker(repo, classifyWith(model), config.worker);
worker.start();

const app = createApp(repo).listen(config.port);
console.log(`listening on http://localhost:${config.port}`);

/**
 * Stop claiming and stop accepting at the same moment, then let both drain: in-flight requests
 * complete and in-flight classifications finish. A second signal force-kills.
 */
async function shutdown(signal: string) {
  console.log(`${signal}: draining`);
  const drained = worker.stop();
  await app.stop();
  await drained;
  db.close();
  console.log("stopped");
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
