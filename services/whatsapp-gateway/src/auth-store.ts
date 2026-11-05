import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type AuthenticationCreds,
  type SignalDataTypeMap
} from "@whiskeysockets/baileys";
import type { GatewayStore } from "./store.js";

export interface LoadedAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export function loadEncryptedAuthState(store: GatewayStore): LoadedAuthState {
  const creds =
    store.getEncryptedJson<AuthenticationCreds>("auth:creds") ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const values: Record<string, SignalDataTypeMap[typeof type] | undefined> = {};
        for (const id of ids) {
          const value = store.getEncryptedJson<SignalDataTypeMap[typeof type]>(
            "auth:key:" + type + ":" + id
          );
          if (type === "app-state-sync-key" && value) {
            values[id] = proto.Message.AppStateSyncKeyData.fromObject(value as object) as
              SignalDataTypeMap[typeof type];
          } else {
            values[id] = value ?? undefined;
          }
        }
        return values;
      },
      set: async (data) => {
        for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
          const entries = data[category] as Record<string, SignalDataTypeMap[typeof category] | null>;
          for (const [id, value] of Object.entries(entries)) {
            const recordKey = "auth:key:" + category + ":" + id;
            if (value == null) store.deleteEncryptedJson(recordKey);
            else store.setEncryptedJson(recordKey, value);
          }
        }
      }
    }
  };

  return {
    state,
    saveCreds: async () => {
      store.setEncryptedJson(
        "auth:creds",
        JSON.parse(JSON.stringify(creds, BufferJSON.replacer), BufferJSON.reviver)
      );
    }
  };
}
