-- 000138 down: deliberately a no-op.
--
-- The up migration closed the Supabase Data API on schema public: it revoked
-- what PUBLIC, anon and authenticated held there, stopped postgres's default
-- privileges from granting new objects to them, and enabled row level
-- security. The literal inverse is to give the Data API's anonymous role
-- SELECT, INSERT, UPDATE, DELETE and TRUNCATE on every table and view again,
-- plus the sequences and EXECUTE on the refresh functions. That must never
-- happen as a side effect of `migrate down`, and nothing needs it: the backend
-- owns every object and has BYPASSRLS, so the up migration changed nothing it
-- can see and there is nothing to restore for it. Turning row level security
-- back off is likewise never needed by the backend.
--
-- If a specific grant is ever wanted on purpose (say, one view published
-- through the Data API), write a NEW migration that grants exactly that, to
-- exactly one role, and change services/migrations/data_api_grants.test.mjs in
-- the same change, since it forbids such a grant until then.

SELECT 1;
