# TMail Machine API — Agent Integration

This is the supported machine-to-machine interface for Seiton agents. It does not use
the owner-panel login, owner password, browser session cookie, or dashboard endpoints.

## Production connection

- Base URL: `https://mail.seiton.biz.id`
- API prefix: `/api/v1/machine`
- Authentication: `Authorization: Bearer <token>`
- Cloudflare Worker secret that backs the credential: `MAIL_VM_API_TOKEN`
- Agent-side secret name recommended for configuration: `TMAIL_API_TOKEN`

The value of `MAIL_VM_API_TOKEN` must be copied into the agent's private secret store
as `TMAIL_API_TOKEN`. Do not place it in source code, a prompt, GitHub, task output,
logs, or a normal chat message. The value is intentionally not documented here.

The machine credential is separate from the owner login. An agent must never be given
the owner password, `__Host-mail_session` cookie, `MAIL_SETUP_TOKEN`, or
`MAIL_MESSAGE_ENCRYPTION_KEY`.

## Authentication and isolation

Every machine endpoint requires the Bearer token. Requests without a valid token are
rejected with HTTP 401. If the machine API secret is not configured on the Worker,
the service returns HTTP 503.

Machine-created mailboxes are associated with a hash of the Bearer token. The token can
list, read, and revoke only the mailboxes associated with that token. It cannot access
the owner panel's browser session or use owner-only endpoints.

**Current credential model:** the Worker currently accepts one configured
`MAIL_VM_API_TOKEN`. Any agent configured with that same value shares the same
machine mailbox scope and rate limits. Treat it as one service identity; do not give
the same credential to unrelated third parties. Separate per-agent credentials with
independent revocation are not yet implemented.

## Mailbox policy and limits

- Each newly created mailbox receives a random 32-character hexadecimal local part
  at `@seiton.my.id`.
- Lifetime is fixed at 600 seconds (10 minutes). The client cannot extend it.
- A mailbox accepts at most 100 messages.
- Message listing returns at most 50 messages per page.
- Mailboxes become unreadable after expiration. The Worker cleanup runs every 10 minutes.
- Attachments are not stored or returned.
- Email is inbound-only; this API does not send email.
- Rate limit: 120 machine API requests per token per 60-second window.
- Mailbox creation limit: 20 new mailboxes per token per rolling hour.
- HTTP 429 responses include `Retry-After` where applicable.

Use a unique `clientRef` for each logical agent task. Keep it stable across retries of
that same task so a retry reuses an active mailbox instead of creating duplicates.
Do not reuse a `clientRef` for a different task. If the original mailbox has expired,
the API returns HTTP 409 for that old reference; create a new task reference.

## Endpoints

All endpoints below require the Bearer token.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/machine/health` | Check Worker and D1 readiness |
| POST | `/api/v1/machine/mailboxes` | Create or reuse a mailbox |
| GET | `/api/v1/machine/mailboxes?limit=25&offset=0` | List mailboxes owned by this token |
| DELETE | `/api/v1/machine/mailboxes/:mailboxId` | Revoke a mailbox and delete its messages |
| GET | `/api/v1/machine/messages?mailboxId=:id` | List message summaries |
| GET | `/api/v1/machine/messages/:messageId?mailboxId=:id` | Read one message body |

Legacy `/api/v1/machine/aliases` paths remain for compatibility. New agent integrations
should use the `mailboxes` paths.

### Create mailbox

Request:

```http
POST /api/v1/machine/mailboxes
Authorization: Bearer <TMAIL_API_TOKEN>
Content-Type: application/json

{
  "label": "signup-task-4821",
  "ttlSeconds": 600,
  "clientRef": "signup-task-4821"
}
```

The API enforces 600 seconds regardless of caller input. A newly created response uses
HTTP 201; a matching active `clientRef` may be returned with HTTP 200 and
`reused: true`.

Response shape:

```json
{
  "ok": true,
  "reused": false,
  "mailbox": {
    "id": "mailbox-uuid",
    "email": "32-hex-characters@seiton.my.id",
    "label": "signup-task-4821",
    "status": "ACTIVE",
    "created_at": 0,
    "expires_at": 0,
    "received_count": 0
  }
}
```

### List messages

```http
GET /api/v1/machine/messages?mailboxId=<mailbox-uuid>
Authorization: Bearer <TMAIL_API_TOKEN>
```

Message summaries include `id`, `sender`, `subject`, `verification_code`, and
`received_at`. Use the `next_cursor.after` and `next_cursor.afterId` values for the
next page when `has_more` is true.

### Read message body

```http
GET /api/v1/machine/messages/<message-uuid>?mailboxId=<mailbox-uuid>
Authorization: Bearer <TMAIL_API_TOKEN>
```

The detail response contains the decoded `body_text`, subject, sender, recipient, and
the extracted verification code. Read only when the summary does not contain enough
information.

## Agent workflow

1. Generate a unique task reference and call `createMailbox`.
2. Give the returned `mailbox.email` to the external service that must send a
   verification email.
3. Poll `listMessages` at a measured interval (for example, every 5 seconds). Do not
   poll faster than necessary; the request limit is 120/minute.
4. Prefer `verification_code` from the message summary. Read the full body only when
   required.
5. Stop polling when the code arrives, the task is cancelled, or `expires_at` passes.
6. Revoke the mailbox when the task finishes early. Expired mailboxes are rejected
   automatically.

Treat OTP values as short-lived secrets: keep them only for the task that requested
them, do not log them, and do not include email contents in general agent memory or
conversation summaries.

## JavaScript client

Use `agent-client.mjs` from this directory:

```js
import { TMailClient } from "./agent-client.mjs";

const tmail = new TMailClient({
  token: env.TMAIL_API_TOKEN
});

const created = await tmail.createMailbox({
  label: "signup-task-4821",
  clientRef: "signup-task-4821"
});

const mailbox = created.mailbox;
const inbox = await tmail.listMessages({ mailboxId: mailbox.id });
const code = inbox.messages.find((message) => message.verification_code)
  ?.verification_code ?? null;
```

The client validates inputs, sends only Bearer authentication, and throws
`TMailApiError` with HTTP status and `retryAfter` for API failures. It never uses an
owner session cookie.

## Error handling

| HTTP | Meaning | Agent action |
|---:|---|---|
| 400 | Invalid body, ID, or pagination | Fix the request; do not retry unchanged |
| 401 | Missing/invalid machine token | Check the private `TMAIL_API_TOKEN` configuration |
| 404 | Mailbox/message not found or not owned by this token | Stop; do not try another token |
| 409 | `clientRef` already belongs to an inactive mailbox | Start a new task with a new `clientRef` |
| 410 | Mailbox expired or inactive | Create a new mailbox for a new task |
| 429 | Request or creation limit reached | Wait for `Retry-After` |
| 503 | Machine API/owner initialization is unavailable | Stop and report service unavailability |

The health endpoint reports Worker and D1 readiness. Its
`inbound_email_routing` field is currently advisory and may say `unverified`; it is
not a substitute for a real inbound-email test.

## cURL smoke test

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $TMAIL_API_TOKEN" \
  "https://mail.seiton.biz.id/api/v1/machine/health"
```

Do not run mailbox creation as a health check. Use a real task reference only when an
agent is intentionally starting an email-verification flow.
