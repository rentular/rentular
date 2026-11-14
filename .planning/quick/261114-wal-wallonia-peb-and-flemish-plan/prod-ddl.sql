-- 261114-wal: Walloon PEB rule of 2022-2023 (decree of 19 October 2022), stored per lease.
-- Additive only. Run BEFORE deploying the code that reads these columns.
-- Requires the 261114-bru DDL first (lease_registered, brussels_epc_factor*).
-- Prod is MariaDB (host DB `rentular`), which supports ADD COLUMN IF NOT EXISTS.

ALTER TABLE `leases`
  ADD COLUMN IF NOT EXISTS `wallonia_peb_label_2022` varchar(4) NULL,
  ADD COLUMN IF NOT EXISTS `wallonia_adapted_rent` decimal(10,2) NULL,
  ADD COLUMN IF NOT EXISTS `wallonia_adapted_index` decimal(8,2) NULL,
  ADD COLUMN IF NOT EXISTS `wallonia_adapted_index_month` varchar(7) NULL;
