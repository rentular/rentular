-- 261114-gcx: per-landlord GoCardless connections (hosted rentular.com).
-- Additive only: one new table. Apply BEFORE deploying the code, because the
-- API reads this table for every GoCardless call on a hosted install and for
-- every GoCardless webhook.

CREATE TABLE IF NOT EXISTS gocardless_connections (
  id varchar(36) NOT NULL,
  owner_id varchar(255) NOT NULL,
  organisation_id varchar(64) NOT NULL,
  creditor_id varchar(64) NULL DEFAULT NULL,
  creditor_name varchar(255) NULL DEFAULT NULL,
  access_token_encrypted text NULL,
  access_token_iv varchar(64) NULL DEFAULT NULL,
  access_token_auth_tag varchar(64) NULL DEFAULT NULL,
  environment ENUM('sandbox','live') NOT NULL,
  scheme varchar(32) NULL DEFAULT NULL,
  status ENUM('active','revoked','error') NOT NULL DEFAULT 'active',
  connected_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error text NULL,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY gocardless_connections_owner_id_unique (owner_id),
  KEY gocardless_connections_organisation_idx (organisation_id),
  CONSTRAINT gocardless_connections_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES users (id)
);
-- If the foreign key is rejected (errno 150, charset or collation of users.id
-- differs), run the CREATE TABLE again without the CONSTRAINT line. The code
-- does not rely on the constraint.
