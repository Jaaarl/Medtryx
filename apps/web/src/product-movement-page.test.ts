import { describe, expect, it } from "vitest";
import { filterProductMovements } from "./product-movement-page";

function product(
  id: string,
  name: string,
  sku: string,
  movement: "FAST" | "SLOW",
) {
  return {
    id,
    name,
    sku,
    unit: "tablet",
    quantityOnHand: 5,
    unitsSold: 10,
    unitsReturned: 0,
    netUnitsMoved: 10,
    averageUnitsMovedPerDay: 1,
    transactionCount: 10,
    lastSoldAt: null,
    movement,
  };
}

describe("product movement search", () => {
  const products = [
    product("1", "Paracetamol 500 mg", "MED-PARA-500", "FAST"),
    product("2", "Amoxicillin 250 mg", "MED-AMOX-250", "SLOW"),
  ];

  it("matches product names and SKUs without case sensitivity", () => {
    expect(
      filterProductMovements(products, "ALL", "  pArA  ").map((row) => row.id),
    ).toEqual(["1"]);
    expect(
      filterProductMovements(products, "ALL", "amox-250").map((row) => row.id),
    ).toEqual(["2"]);
  });

  it("applies the movement filter together with the search", () => {
    expect(
      filterProductMovements(products, "FAST", "MED").map((row) => row.id),
    ).toEqual(["1"]);
    expect(filterProductMovements(products, "SLOW", "para")).toEqual([]);
  });
});
