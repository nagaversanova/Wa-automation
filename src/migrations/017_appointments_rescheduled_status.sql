-- 017_appointments_rescheduled_status.sql: Allow 'rescheduled' status in appointments

DO $$
BEGIN
    ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
    ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
        CHECK(status IN ('confirmed', 'cancelled', 'rescheduled'));
END $$;
