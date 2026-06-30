import { createApp } from "./app";
import type { WebhookQueueMessage, WorkerEnv } from "./types";
import { processWebhookQueueMessage, runScheduledMaintenance } from "./worker";

const app = createApp();

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<WebhookQueueMessage>, env: WorkerEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processWebhookQueueMessage(env, message.body);
        message.ack();
      } catch (error) {
        console.error("Queue message failed", error);
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: WorkerEnv): Promise<void> {
    await runScheduledMaintenance(env);
  },
};
