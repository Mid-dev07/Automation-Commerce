import { readFileSync } from "node:fs";

export interface GatewayConfig {
  host: string;
  port: number;
  databasePath: string;
  workerUrl: string;
  workerHmacSecret: Buffer;
  authEncryptionKey: Buffer;
  logLevel: string;
}

function readSecret(fileVariable: string): string {
  const path = process.env[fileVariable];
  if (!path) throw new Error(fileVariable + " is required.");
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(fileVariable + " points to an empty secret.");
  return value;
}

export function loadConfig(): GatewayConfig {
  const workerUrl = String(process.env.SEITON_WORKER_URL || "").replace(/\\/+$/, "");
  if (!/^https:\\/\\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(workerUrl)) {
    throw new Error("SEITON_WORKER_URL must be an HTTPS origin.");
  }

  const workerHmacSecret = Buffer.from(
    readSecret("SEITON_WORKER_HMAC_SECRET_FILE"),
    "utf8"
  );
  if (workerHmacSecret.length < 32) {
    throw new Error("Worker HMAC secret must contain at least 32 bytes.");
  }

  const authKeyHex = readSecret("AUTH_ENCRYPTION_KEY_FILE");
  if (!/^[a-f0-9]{64}$/i.test(authKeyHex)) {
    throw new Error("Auth encryption key must be exactly 64 hexadecimal characters.");
  }

  const port = Number(process.env.PORT || 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT is invalid.");
  }

  return {
    host: process.env.HOST || "0.0.0.0",
    port,
    databasePath: process.env.DB_PATH || "/var/lib/seiton-whatsapp/gateway.sqlite",
    workerUrl,
    workerHmacSecret,
    authEncryptionKey: Buffer.from(authKeyHex, "hex"),
    logLevel: process.env.LOG_LEVEL || "info"
  };
}
