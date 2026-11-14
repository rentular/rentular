-- Quick task 261114-umk: undo for "mark month paid".
-- Apply on prod (database `rentular`) after a backup, BEFORE deploying the code.
-- The code writes a row here on every manual mark and reads it on the overview,
-- the payments list and the contract page, so the table must exist first.
-- Only additive: one new table, nothing else changes.

CREATE TABLE IF NOT EXISTS payment_manual_marks (
  id varchar(36) NOT NULL,
  lease_id varchar(36) NOT NULL,
  month varchar(7) NOT NULL,
  payment_id varchar(36) NOT NULL,
  created_row boolean NOT NULL DEFAULT false,
  before_state json NULL DEFAULT NULL,
  after_state json NULL DEFAULT NULL,
  source ENUM('overview','api','magic_link','mcp','other') NOT NULL DEFAULT 'other',
  marked_by varchar(255) NULL DEFAULT NULL,
  marked_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  undone_at timestamp NULL DEFAULT NULL,
  undone_by varchar(255) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY pmm_lease_month_undone_idx (lease_id, month, undone_at),
  KEY pmm_payment_idx (payment_id),
  CONSTRAINT payment_manual_marks_lease_id_leases_id_fk FOREIGN KEY (lease_id) REFERENCES leases (id)
);
-- If the foreign key is rejected (errno 150, charset or collation of leases.id
-- differs), run the CREATE TABLE again without the CONSTRAINT line. The code
-- does not depend on it.
-- payment_id deliberately has no foreign key: undoing a mark that created its
-- payment row deletes that row, and the mark stays as history.
-- On MariaDB `json` is an alias for longtext with a JSON_VALID check; that is fine.

-- Check afterwards:
-- SHOW CREATE TABLE payment_manual_marks;
