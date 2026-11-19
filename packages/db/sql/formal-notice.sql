-- Registered formal notice of default (aangetekende ingebrekestelling):
-- the landlord's postal address for the sender block of the letter, the
-- tenant's optional correspondence address for the addressee block, and the
-- communications enum value used to log a posted notice.
-- Apply to the `rentular` MariaDB after a `mysqldump rentular` backup.
-- Idempotent: safe to run more than once.
--
-- Hand-written on purpose: `drizzle-kit push` throws
-- `TypeError: reading 'checkConstraint'` while introspecting this MariaDB, and
-- `db:generate` replays a stale 0000 baseline (phantom CREATE TABLE and
-- unrelated ALTER TABLE statements against tables that already exist).
--
-- Verify the enum before and after with:
--   SHOW COLUMNS FROM communications LIKE 'type';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS street VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS street_number VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS box VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS postal_code VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS city VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS country VARCHAR(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'BE';

-- No default on correspondence_country: a NULL country marks "no
-- correspondence address on file", which the letter needs to tell apart from a
-- Belgian address.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS correspondence_street VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS correspondence_street_number VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS correspondence_box VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS correspondence_postal_code VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS correspondence_city VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN IF NOT EXISTS correspondence_country VARCHAR(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL;

-- MariaDB stores ENUM values as ordinal indexes and has no ADD VALUE, so the
-- whole list is restated with 'formal_notice' appended LAST. Restating a
-- superset in the same order keeps existing rows intact and can be re-run
-- without effect. The order must stay byte-identical to the array in
-- packages/db/src/schema/communications.ts (asserted by
-- apps/api/src/__tests__/formalNoticeDdl.test.ts).
ALTER TABLE communications
  MODIFY COLUMN type ENUM(
    'payment_reminder_friendly',
    'payment_reminder_formal',
    'payment_reminder_final',
    'indexation_notification',
    'landlord_report',
    'custom',
    'welcome',
    'lease_renewal',
    'lease_termination',
    'other',
    'indexation_alert',
    'landlord_notification',
    'due_date_sms',
    'tenant_reply',
    'internal_note',
    'formal_notice'
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;
