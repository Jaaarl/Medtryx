ALTER TABLE users ADD COLUMN username TEXT COLLATE NOCASE;

UPDATE users AS current_user
SET username = CASE
  WHEN lower(substr(current_user.email, 1, min(instr(current_user.email, '@') - 1, 64))) NOT LIKE 'staff-%'
    AND (
      SELECT COUNT(*)
      FROM users AS other_user
      WHERE lower(substr(other_user.email, 1, min(instr(other_user.email, '@') - 1, 64)))
        = lower(substr(current_user.email, 1, min(instr(current_user.email, '@') - 1, 64)))
    ) = 1
  THEN lower(substr(current_user.email, 1, min(instr(current_user.email, '@') - 1, 64)))
  ELSE 'staff-' || lower(replace(current_user.id, '-', ''))
END;

CREATE UNIQUE INDEX users_username_unique_idx
  ON users(username COLLATE NOCASE)
  WHERE username IS NOT NULL;
