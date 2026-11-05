import { createHash, createHmac, randomUUID } from "node:crypto";

export interface WorkerCommand {
  event_id: string;
  message_id: string;
  chat_id: string;
  push_name: string;
  text: string;
  from_me: false;
  chat_type: "direct";
}

export interface WorkerAction {
  action_id: string;
  type: "send_text";
  text: string;
}

export class SeitonWorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly hmacSecret: Buffer
  ) {}

  async processCommand(command: WorkerCommand): Promise<WorkerAction[]> {
    const path = "/internal/whatsapp/command";
    const body = JSON.stringify(command);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    const signed = [
      "v1",
      timestamp,
      nonce,
      "POST",
      path,
      bodyHash
    ].join("\n");
    const signature = createHmac("sha256", this.hmacSecret).update(signed).digest("hex");

    const response = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seiton-timestamp": timestamp,
        "x-seiton-nonce": nonce,
        "x-seiton-signature": signature
      },
      body,
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) {
      throw new Error("WORKER_HTTP_" + response.status);
    }

    const result = await response.json() as {
      accepted?: boolean;
      actions?: Array<{ action_id?: string; type?: string; text?: string }>;
    };

    if (result.accepted !== true || !Array.isArray(result.actions)) {
      throw new Error("WORKER_RESPONSE_INVALID");
    }

    return result.actions
      .filter((action): action is { action_id: string; type: "send_text"; text: string } =>
        typeof action.action_id === "string" &&
        action.type === "send_text" &&
        typeof action.text === "string"
      )
      .map(action => ({
        action_id: action.action_id.slice(0, 200),
        type: "send_text",
        text: action.text.slice(0, 3000)
      }));
  }
}
