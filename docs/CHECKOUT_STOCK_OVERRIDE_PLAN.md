# Checkout stock override: feature and workflow plan

Status: proposed implementation. This document plans the feature; it does not enable it or change the local database.

## Recommended behavior

Add an owner-controlled setting called **Allow checkout stock count override**, disabled by default. When enabled, a cashier can sell physically available units beyond the recorded saleable quantity after confirming the count and giving a reason.

Record the confirmed stock correction and the sale together. For the example where the system records 21 units but the cashier verifies 22:

| Step                       | Inventory movement | Recorded quantity |
| -------------------------- | ------------------ | ----------------- |
| Before checkout            | Existing stock     | 21                |
| Confirmed count correction | +1                 | 22                |
| Completed sale             | -22                | 0                 |

The receipt charges for all 22 units. Inventory history shows both the correction and the sale, linked to the transaction and cashier.

This is the recommended design because the current database requires nonnegative stock and inventory value. Simply bypassing the checkout limit would still fail at sale finalization and would conflict with the lot ledger. A confirmed correction preserves those rules and makes the miscount traceable.

## Settings and permissions

Place a **Checkout inventory** card on the existing Settings page.

| Control                             | Default | Behavior                                                                      |
| ----------------------------------- | ------- | ----------------------------------------------------------------------------- |
| Allow checkout stock count override | Off     | Allows a cashier to confirm a physical count correction during live checkout. |

Suggested description:

> Allow cashiers to complete a sale when physically verified stock exceeds the recorded quantity. Each override requires a count confirmation and reason, and records a stock correction with the sale. Expiry and quarantine restrictions still apply.

- Only the owner can enable or disable the setting. Record the old value, new value, owner, and timestamp in the audit log.
- Enabling it authorizes active cashiers to use this specific checkout workflow. No owner password is required for each routine override.
- Cashiers can read whether the feature is available, but cannot edit the setting or access general inventory adjustment permissions.
- Keep the existing owner-only stock adjustment routes owner-only. The new cashier capability applies only to a correction attached to a successfully completed sale.
- Show a small checkout status indicator when enabled. Require explicit confirmation only when stock is insufficient.
- If the setting is missing or cannot be validated, apply the existing stock limits. The server is authoritative.
- Turning it off blocks new override sales, including carts previously previewed while it was on. Already completed transactions retain their history.

## Cashier workflow

### Setting disabled

Keep the existing add-product and quantity limits. If a cashier finds a count discrepancy, the owner uses the existing inventory adjustment workflow before the sale proceeds.

### Setting enabled

1. The cashier finds or scans the product, including an active product recorded at zero stock.
2. The cashier enters the requested quantity. For example, 22 units when 21 are recorded.
3. Instead of silently reducing the quantity or showing only an out-of-stock error, open a **Confirm physical stock** dialog.
4. Show the product, unit, current recorded saleable quantity, total requested quantity, and shortage. For the example: recorded 21, requested 22, shortage 1.
5. Ask for the **physically verified quantity currently available before this sale**. Explain that this is a shelf count, not just the quantity the customer wants. For a non-lot product, it is the total count of that product in its selling unit. Entering 22 produces a correction of +1; entering 25 produces +4 and leaves 3 after selling 22.
6. Require a reason, defaulting the category to **Count discrepancy**, plus a short explanation such as "Recounted shelf stock: 22 units present, system shows 21." Require at least three non-whitespace characters.
7. Require a checkbox: **I physically verified these units are available and suitable for sale.**
8. Display the calculated correction and quantity remaining after the sale. Buttons: **Cancel** and **Confirm count and add**.
9. Add the requested quantity and mark the affected cart product **Count override: +1**. This confirmation is provisional; adding to the cart does not change inventory.
10. In the final checkout preview, show an override summary and the usual total, payment, and lot-pick confirmation.
11. On successful sale completion, save the stock correction, inventory value movement, sale, and audit records in one database transaction.
12. Show the normal sale success state plus "Stock count correction recorded." The customer's receipt contains normal purchased quantities and totals; internal reasons remain in staff history.

For a product recorded at zero, show **Add with count confirmation** when enabled. It still needs a positive physical count and a valid cost basis. If no cost basis exists, explain that the owner must record stock and acquisition cost before the sale can proceed.

Canceling the dialog keeps the cart unchanged. Removing the product removes its provisional override. Abandoning checkout, closing the page, or failing payment validation creates no stock adjustment.

## Rules for quantities and cart changes

- Quantities use the product's existing selling unit and positive integer limits. The feature does not introduce fractional quantities or unit conversion.
- Preserve the quantity the cashier enters. Under the enabled setting, replace the current quantity clamping with either ordinary acceptance or a count-confirmation prompt.
- Calculate demand by product across the entire cart, including repeated additions and expanded bundle components. A product appearing directly and in a bundle must not be counted twice as available stock.
- A physical count must cover the total quantity to be sold. If it does not, ask the cashier to reduce the sale quantity or cancel.
- Record the full verified discrepancy, not an invented amount just large enough to make the sale pass. A downward or zero discrepancy does not qualify for this workflow; use normal checkout or owner adjustment instead.
- Changing product quantities, bundle quantities, or confirmed lot selections invalidates the preview and affected override confirmation. Reconfirm before completing the sale. This prevents obsolete confirmations from silently authorizing changed demand.
- Resolve multiple insufficient products individually, then show them together in the final summary. If any required confirmation fails, the entire sale remains unsaved.
- Keep bundle purchase limits, pricing, discounts, active-product checks, approved tax policy, payment checks, and register/shift requirements in force.
- Initial scope is live Checkout, including its bundle component demand. Owner-only backdated Manual checkout retains its existing stock rules; historical count corrections need a separate design.

## Batch, expiry, and quarantine workflow

For lot-tracked products, verify counts **per identified saleable lot** rather than entering only an overall product quantity.

- Let the cashier select an existing, non-expired, non-quarantined lot, including one with a recorded balance of zero. Show its batch code, expiry date, recorded lot balance, and physical-count field.
- Calculate each correction as `verified physical lot count - recorded lot balance`. Apply only positive corrections to the specified lots.
- Preserve other lots, quarantined quantities, expired quantities, and unallocated balances. The product correction equals the sum of confirmed lot corrections.
- Recalculate first-expiry-first-out allocations after the provisional corrections and require the existing lot-pick confirmation against that allocation.
- Never sell expired or quarantined units through this setting. Recheck saleability at completion using the application's Manila business-date rules.
- Never invent a batch, expiry date, or allocation for unallocated stock. An unknown batch or unallocated stock requires the owner's existing receipt/reconciliation workflow first.

Example: the product has 21 units in a valid batch and the cashier counts 22 in that same batch. Add +1 to that batch, then allocate the 22-unit sale normally. If the extra unit is expired, it does not qualify.

## Inventory value and sale cancellation

Every positive correction must add both quantity and acquisition value before the sale calculates its existing weighted-average cost of goods sold (COGS).

Recommended cost selection, computed by the server and hidden from cashier screens:

1. When recorded product quantity is positive, use the current weighted-average acquisition cost, with the existing centavo rounding rules.
2. When recorded quantity is zero, use the most recent eligible owner-recorded opening-stock or receipt acquisition cost. Record its source event. Do not take the cost from a selling price, sale, reversal, or a prior estimated checkout correction.
3. If neither provides a valid cost basis, block the override and direct the owner to record a costed stock adjustment or receipt. Do not invent a zero cost. Existing explicit owner-recorded zero-cost stock may be used with its source and justification retained.

Snapshot the selected cost, its source, and whether it was estimated. Show estimated correction costs to the owner in override history. Deriving cost is a proposed operational policy for this feature, not a change to previously saved sale costs.

After the correction, run the normal COGS allocation and rounding. Quantity and value must reconcile across products, stock events, and lot movements, with zero inventory value when quantity reaches zero.

Canceling or reversing a completed sale uses the existing restock/write-off choices and original saved COGS. Keep the count correction as a separate historical fact. For example, fully restocking the 22-unit sale restores 22 units, rather than undoing the correction and restoring only 21. An incorrect physical count is corrected through a new owner adjustment, never by deleting history.

## Owner visibility and audit

Add an owner-only **Checkout count overrides** view within Stock, linked from the Settings card. Reuse existing stock movement and audit presentation where possible.

Show transaction, date/time, cashier, product, unit, recorded count, verified physical count, correction quantity, sold quantity, reason, and lot identity where applicable. Owners can also inspect the correction's acquisition cost source and value.

- Filter by date, cashier, and product; open the linked sale and stock movement history.
- Mark records **Unreviewed** or **Reviewed**. Review is acknowledgment, not a second inventory adjustment or prerequisite to dispensing.
- Record reviewer, timestamp, and optional note. Keep original correction evidence unchanged.
- Flag estimated cost sources in the owner view so they can be checked against receipt records.
- Exports should include override evidence in the owner override report. Existing sales reports continue to use normal sale quantities, revenue, and saved COGS; the correction is not a receipt or additional sales revenue.

The discrepancy is reconciled when the sale commits. "Unreviewed" means the owner has not checked the evidence; it does not mean the inventory correction is still pending.

## Proposed implementation fit

The current implementation has relevant checks in:

| Existing location                  | Planned change                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app.tsx`             | Add the Settings card using the existing owner access rules.                                                                                |
| `apps/web/src/inventory-pages.tsx` | Update product/bundle add limits, quantity prompts, cart editing, preview, and final confirmation.                                          |
| `apps/server/src/sales.ts`         | Validate provisional count evidence, preview corrected availability, apply corrections atomically, and include evidence in request hashing. |
| `apps/server/src/inventory.ts`     | Reuse adjustment rules, expose owner history, and retain existing owner-only general adjustment endpoints.                                  |
| `apps/server/src/lot-stock.ts`     | Reuse lot movements, allocation, and ledger reconciliation checks.                                                                          |
| `apps/server/src/bundles.ts`       | Account for component demand and review any availability filters that would hide an override-eligible offer.                                |
| `database/migrations/`             | Add a migration for the setting and override evidence; preserve existing nonnegative constraints.                                           |

Suggested API shape:

- `GET /api/settings/checkout-inventory`: authenticated read of effective availability and policy version; expose no acquisition costs to cashiers.
- `PUT /api/settings/checkout-inventory`: owner-only update, CSRF protection, schema validation, and audit logging.
- Extend existing `/api/sales/preview` and `/api/sales` requests with per-product/per-lot count evidence, a required reason and confirmation, the observed stock state, and policy version.
- Add owner-only endpoints for override history and review acknowledgment. Follow existing authentication and CSRF conventions.

### Database changes

Use the existing `settings` table with a new key such as `checkout_inventory` and a value containing `allowStockCountOverride: false` plus a policy version. Seed without overwriting an existing value.

Add immutable sale-linked override evidence, with product/lot records where needed. Store the cashier, sale, recorded and physical counts, correction quantity, reason, confirmed stock-state snapshot, policy version, timestamp, and linked `ADJUSTMENT` stock event(s). Store cost source and value internally. Use foreign keys and checks for positive corrections. Keep review acknowledgments separately so review does not mutate original evidence.

Reuse existing `ADJUSTMENT` stock events and corresponding lot movements. Every correction must reconcile with the product and lot ledgers. Existing records need no fabricated override evidence or stock backfill.

### Atomic completion and concurrent changes

Preview simulates the proposed correction in memory; it must not write inventory or audit events. Use the same calculation rules for preview and completion.

At completion, in the existing sale transaction:

1. Check for an already completed request using the existing idempotency key and hash. An identical retry returns the saved sale without repeating any correction, even if the setting has since been disabled.
2. For a new sale, recheck the current setting, actor, register/shift, product state, cost basis, and lot saleability.
3. Compare current relevant product balances, value/cost source, lot state, and policy version against the confirmed snapshot. If inventory or policy changed, require a refreshed preview and count confirmation; do not silently enlarge the adjustment to compensate for an intervening sale.
4. Validate aggregate product demand and all count evidence. Apply each positive correction with matching stock events and lot movements.
5. Recalculate and validate the sale and lot allocations against the corrected state, then save sale lines, normal sale deductions, override evidence, and audit entries.
6. Commit everything together. Any failure rolls back corrections and the sale. Reusing the key with changed count evidence must produce the existing changed-request conflict.

## Acceptance and test plan

These are required checks for the future implementation, not tests already run for this planning document.

| Scenario                                                                                  | Expected result                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Fresh database or existing local database upgraded                                        | Setting defaults to off; existing stock/history is preserved.                              |
| Setting off: recorded 21, requested 22                                                    | Existing checkout limits remain enforced.                                                  |
| Setting on: recorded 21, physical 22, requested 22                                        | +1 correction and -22 sale commit together; quantity and value end at zero.                |
| Setting on: recorded 21, physical 25, requested 22                                        | +4 correction and -22 sale; three units remain with reconciled value.                      |
| Recorded zero, physical one, valid prior acquisition cost                                 | Product can be added through confirmation and sold; cost source is recorded.               |
| Recorded zero and no valid cost basis                                                     | Clear owner-action message; no adjustment or sale saved.                                   |
| Blank reason, no physical confirmation, invalid quantity, or physical count below demand  | Request rejected without writes.                                                           |
| Extra units belong to a known valid lot with zero recorded balance                        | Correct that lot, recalculate allocation, and require lot-pick confirmation.               |
| Expired/quarantined batch, unknown batch, or unallocated tracked stock                    | Cannot bypass lot saleability or reconciliation requirements.                              |
| Same product added repeatedly or used in multiple bundles                                 | Validate total demand; save only the confirmed discrepancy once.                           |
| Cart canceled, abandoned, edited, or preview repeatedly requested                         | No inventory writes during preview; affected evidence requires reconfirmation after edits. |
| Stock, lot, cost source, or policy changes after confirmation                             | Require fresh evidence; no automatic stock top-up.                                         |
| Owner disables setting before completion                                                  | Pending override sale blocked; ordinary in-stock sales remain available.                   |
| Double-click, timeout retry, or identical repeated sale request                           | Exactly one sale and one set of corrections.                                               |
| Same request key with changed override evidence                                           | Changed-request conflict; original sale preserved.                                         |
| Failure after applying a correction within the transaction                                | Entire sale and correction roll back.                                                      |
| Full reversal with restock or write-off                                                   | Existing reversal rules and original COGS apply; original correction remains visible.      |
| Cashier attempts setting change, general adjustment, cost access, or owner history access | Server denies unauthorized access.                                                         |
| Normal stock, CASH/QR, benefit discounts, bundles, and manual checkout                    | Existing behavior remains correct in both setting states.                                  |

Test server validation, idempotency, ledger invariants, and rollback with automated tests. Run checkout end-to-end tests for each quantity entry path: product button, barcode lookup, quantity dialog, cart input, increment/decrement, and bundle addition. Test the migration on a fresh database and a copy of an existing locally deployed database.

Relevant existing suites include `apps/server/src/sales.test.ts`, `inventory.test.ts`, `bundles.test.ts`, `reversals.test.ts`, `db.test.ts`, and inventory/checkout scenarios in `tests/e2e`. Run the applicable project type checks and final regression suite before committing implementation.

## Suggested delivery order

1. Implement the default-off setting, migrations, permission rules, immutable evidence, and transactional correction calculation.
2. Complete live checkout confirmation for direct products, zero-stock products, and lot-tracked products.
3. Complete aggregate bundle handling, retries, policy changes, and reversal integration.
4. Add owner history/review and validate the full workflow in the local deployment environment.

These are implementation stages of the same proposed feature. Follow the repository's separate-commit rule for each independently completed requested feature; do not deploy an enabled partial workflow.

Before implementation deployment, back up the local database, apply and test the migration on a copy, and verify ledger reconciliation. Deploy compatible application code and schema together. Leave the setting off until the complete workflow passes its tests and the owner chooses to enable it.
