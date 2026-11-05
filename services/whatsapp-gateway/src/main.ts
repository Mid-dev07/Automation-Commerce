import Fastify from "fastify";
import pino from "pino";
import { loadConfig } from "./config.js";
import { loadEncryptedAuthState } from "./auth-store.js";
import { BaileysSession } from "./baileys-session.js";
import { InboundProcessor } from "./inbound-processor.js";
import { GatewayStore } from "./store.js";
import { SeitonWorkerClient } from "./worker-client.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new GatewayStore(config.databasePath, config.authEncryptionKey);
  store.recoverAfterRestart();

  const auth = loadEncryptedAuthState(store);
  const worker = new SeitonWorkerClient(config.workerUrl, config.workerHmacSecret);
  const logger = pino({ level: config.logLevel, redact: ["*.chat_id", "*.jid", "*.text", "*.push_name"] });
  const processor = new InboundProcessor(store, worker, logger);
  const session = new BaileysSession(auth, processor, logger);

  const app = Fastify({
    logger: false,
    bodyLimit: 1024
  });

  app.get("/health/live", async () => ({
    ok: true,
    service: "seiton-whatsapp-gateway-pilot"
  }));

  app.get("/health/ready", async () => ({
    ok: true,
    service: "seiton-whatsapp-gateway-pilot",
    connection_state: session.getState()
  }));

  await app.listen({ host: config.host, port: config.port });
  await session.start();

  logger.info(
    { event: "gateway_started", connection_state: session.getState() },
    "Seiton WhatsApp pilot gateway started"
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "gateway_shutdown", signal }, "Gateway shutdown requested");
    await session.stop();
    await app.close();
    store.close();
  };

  process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(0)); });
}

main().catch(error => {
  const code = error instanceof Error ? error.name : "STARTUP_ERROR";
  process.stderr.write(JSON.stringify({
    level: "error",
    event: "gateway_start_failed",
    code
  }) + "\n");
  process.exitCode = 1;
});
