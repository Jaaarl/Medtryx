DROP TRIGGER inventory_lots_identity_immutable;

CREATE TRIGGER inventory_lots_identity_immutable
BEFORE UPDATE OF product_id, lot_code, created_at, created_by_user_id ON inventory_lots
BEGIN
  SELECT RAISE(ABORT, 'inventory_lot_identity_is_immutable');
END;
