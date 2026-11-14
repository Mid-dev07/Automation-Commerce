-- Encrypt inbound email content at application level using a Worker Secret.
-- The D1 database is dedicated to the mail automation panel.
ALTER TABLE mail_messages ADD COLUMN payload_iv TEXT;
ALTER TABLE mail_messages ADD COLUMN payload_ciphertext TEXT;
