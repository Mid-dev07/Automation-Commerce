# Public Seiton TMail Service

## User experience

- `/` is the public TMail landing page.
- `/inbox/:localPart` opens the password-protected mailbox page.
- `/owner` is the private Owner dashboard. The legacy `/login` route remains available.
- The public interface has **Generate** and **Custom** modes, address copying, a protected inbox, OTP extraction, and five-second inbox refresh.

## Mailbox types

| Type | Address | Lifetime | Password |
|---|---|---:|---|
| Generate | Random 32-character hex local part @seiton.my.id | 10 minutes | Random password shown once |
| Custom | User-selected valid local part @seiton.my.id | 365 days | User-chosen password, 12–128 characters |

Custom local parts are 3–32 characters, lowercase letters/numbers with dot, underscore, or hyphen separators. The service rejects reserved labels and duplicate addresses. Only `seiton.my.id` is issued because it is the domain with the configured catch-all Worker routing.

Every public mailbox has a salted PBKDF2 password hash. Public inbox sessions use HttpOnly, Secure, SameSite=Strict cookies scoped to each mailbox. The password is required again when the session expires or the user locks the inbox. A guessed address alone does not grant access.

## Limits and retention

- Maximum 10 public mailbox creations per client IP per rolling hour.
- Five incorrect password attempts for the same IP/mailbox trigger a 15-minute lockout.
- Maximum 100 accepted emails per mailbox.
- Inbox displays up to 50 latest messages.
- The inbox refreshes every five seconds while open.
- Generated mailbox and its messages expire after 10 minutes.
- Custom addresses remain valid for 365 days; message content follows the existing 30-day retention policy.
- Inbound only. Outbound email and attachments are not supported.
- Scheduled cleanup remains every 10 minutes.

## Public API

All calls are same-origin browser requests. Mailbox sessions are established by create or unlock responses and use an HttpOnly cookie.

### Create random mailbox

```http
POST /api/public/mailboxes
Content-Type: application/json

{"mode":"generate"}
```

Response includes `mailbox.email`, `mailbox.slug`, `mailbox.expires_at`, and `generated_password`. The generated password is shown once and must be saved by the user.

### Create custom mailbox

```http
POST /api/public/mailboxes
Content-Type: application/json

{"mode":"custom","localPart":"temakuro","password":"user-chosen-password"}
```

Custom address conflicts return HTTP 409. Password validation failures return HTTP 400.

### Unlock an existing mailbox

```http
POST /api/public/unlock
Content-Type: application/json

{"slug":"temakuro","password":"user-chosen-password"}
```

### Read mailbox messages

```http
GET /api/public/inbox?slug=temakuro
```

Requires the mailbox-specific session cookie. Response contains decrypted message summaries with sender, subject, body text, verification code when detected, and received timestamp.

### Lock inbox

```http
POST /api/public/logout
Content-Type: application/json

{"slug":"temakuro"}
```

## Registration compatibility

Seiton TMail can accept email sent to a valid active address on `seiton.my.id`. Acceptance by a third-party app is controlled by that app. Some providers reject temporary-email domains, require phone or identity checks, apply risk scoring, or block sign-ups under their own policies. Multiple domain aliases or custom local parts cannot guarantee universal acceptance and must not be used to evade another service's anti-abuse restrictions.

For important accounts that need long-term recovery, prefer a mailbox that the account owner controls permanently and use the app's supported recovery methods. Public TMail is designed for short-lived email receipt and ordinary testing, not sensitive or critical account recovery.
