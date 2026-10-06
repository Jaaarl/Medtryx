#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_FILE_BYTES = 200_000;
const MAX_CSV_CHARACTERS = 200_000;
const MAX_DATA_ROWS = 500;
const MAX_QUANTITY = 1_000_000;
const ALLOWED_HEADERS = [
  "sku",
  "name",
  "barcode",
  "unit",
  "sellingprice",
  "taxclass",
  "producttype",
  "issceligible",
  "ispwdeligible",
  "bnpceligible",
  "bnpccategory",
  "trackslots",
  "openingquantity",
  "openingunitcost",
  "reorderlevel",
  "openingreference",
  "openinglotcode",
  "openingexpirydate",
  "openingsupplier",
  "zerocostreason",
];
const REQUIRED_HEADERS = [
  "name",
  "unit",
  "sellingprice",
  "taxclass",
  "producttype",
  "openingquantity",
];
const MONEY_PATTERN = /^\d{1,7}(?:\.\d{1,2})?$/u;
const SKU_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
const BOOLEAN_VALUES = new Set(["true", "yes", "1", "false", "no", "0"]);
const TAX_CLASSES = new Set(["VATABLE", "VAT_EXEMPT", "ZERO_RATED"]);
const PRODUCT_TYPES = new Set(["GENERIC", "BRANDED", "NOT_APPLICABLE"]);
const BNPC_CATEGORIES = new Set(["BASIC_NECESSITY", "PRIME_COMMODITY"]);

function manilaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function parseCsv(source) {
  const csv = source.replace(/^\uFEFF/u, "");
  const records = [];
  let cells = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let recordLine = 1;
  let malformed = false;

  const finishField = () => {
    cells.push(field.trim());
    field = "";
    closedQuote = false;
  };
  const finishRecord = () => {
    finishField();
    if (cells.some((cell) => cell.length > 0)) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
    recordLine = line;
  };

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
        if (character === "\n") line += 1;
      }
      continue;
    }

    if (character === '"') {
      if (field.length !== 0 || closedQuote) {
        malformed = true;
        break;
      }
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      line += 1;
      recordLine = line;
    } else if (closedQuote && !/\s/u.test(character)) {
      malformed = true;
      break;
    } else if (!closedQuote) {
      field += character;
    }
  }

  if (quoted) malformed = true;
  if (malformed) {
    return {
      records: [],
      errors: [`Row ${line}: CSV contains invalid quote formatting.`],
    };
  }
  if (field.length > 0 || cells.length > 0 || closedQuote) finishRecord();
  if (records.length < 2) {
    return {
      records: [],
      errors: ["Row 1: CSV needs a header and at least one data row."],
    };
  }

  const errors = [];
  const headerRecord = records[0];
  const headers = headerRecord.cells.map((header) => header.toLowerCase());
  const headerSet = new Set();
  headers.forEach((header, index) => {
    if (!header) {
      errors.push(`Row 1: Header column ${index + 1} is blank.`);
    } else if (headerSet.has(header)) {
      errors.push(`Row 1: Duplicate header "${header}".`);
    } else if (!ALLOWED_HEADERS.includes(header)) {
      errors.push(`Row 1: Unknown header "${headerRecord.cells[index]}".`);
    }
    headerSet.add(header);
  });
  for (const required of REQUIRED_HEADERS) {
    if (!headerSet.has(required)) {
      errors.push(`Row 1: Missing required header "${required}".`);
    }
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length > MAX_DATA_ROWS) {
    errors.push(`Row 1: CSV can contain at most ${MAX_DATA_ROWS} data rows.`);
  }

  const rows = [];
  for (const record of dataRecords) {
    if (record.cells.length !== headers.length) {
      errors.push(
        `Row ${record.line}: Expected ${headers.length} columns but found ${record.cells.length}.`,
      );
      continue;
    }
    rows.push({
      line: record.line,
      values: Object.fromEntries(
        headers.map((header, index) => [header, record.cells[index]]),
      ),
    });
  }
  return { rows, errors };
}

function checkCsvRow(row, errors, warnings, seenSkus, seenBarcodes, today) {
  const { line, values } = row;
  const error = (column, message) =>
    errors.push(`Row ${line} [${column}]: ${message}`);
  const warning = (column, message) =>
    warnings.push(`Row ${line} [${column}]: ${message}`);
  const value = (column) => values[column] ?? "";
  const lengthCheck = (column, max, required = false) => {
    const current = value(column);
    if (required && !current) error(column, "value is required.");
    if (current.length > max) {
      error(column, `must be at most ${max} characters.`);
    }
  };
  const booleanCheck = (column) => {
    const current = value(column).toLowerCase();
    if (current && !BOOLEAN_VALUES.has(current)) {
      error(column, "must be TRUE/FALSE, YES/NO, or 1/0.");
    }
  };

  const sku = value("sku");
  if (sku) {
    if (sku.length > 48 || !SKU_PATTERN.test(sku)) {
      error("sku", "must be 1–48 characters: letters, digits, dot, underscore, or hyphen; it must start with a letter or digit.");
    }
    const normalizedSku = sku.toUpperCase();
    if (seenSkus.has(normalizedSku)) {
      error("sku", "repeats in this CSV (SKU comparison ignores case). ");
    }
    seenSkus.add(normalizedSku);
  }

  lengthCheck("name", 160, true);
  lengthCheck("barcode", 80);
  if (value("barcode")) {
    const normalizedBarcode = value("barcode").toLowerCase();
    if (seenBarcodes.has(normalizedBarcode)) {
      error("barcode", "repeats in this CSV (barcode comparison ignores case).");
    }
    seenBarcodes.add(normalizedBarcode);
  }
  lengthCheck("unit", 32, true);

  const sellingPrice = value("sellingprice");
  if (!MONEY_PATTERN.test(sellingPrice)) {
    error("sellingPrice", "must be a positive amount with at most 2 decimal places and up to 7 digits before the decimal.");
  } else if (Number(sellingPrice) <= 0) {
    error("sellingPrice", "must be greater than zero.");
  }

  const taxClass = value("taxclass").toUpperCase();
  if (!TAX_CLASSES.has(taxClass)) {
    error("taxClass", "must be VATABLE, VAT_EXEMPT, or ZERO_RATED.");
  } else if (taxClass === "ZERO_RATED") {
    warning("taxClass", "the destination app must have approved settings that allow zero-rated products.");
  }

  const productType = value("producttype").toUpperCase();
  if (!PRODUCT_TYPES.has(productType)) {
    error("productType", "must be GENERIC, BRANDED, or NOT_APPLICABLE.");
  }

  for (const column of [
    "issceligible",
    "ispwdeligible",
    "bnpceligible",
    "trackslots",
  ]) {
    booleanCheck(column);
  }

  const bnpcEligible = ["true", "yes", "1"].includes(
    value("bnpceligible").toLowerCase(),
  );
  const bnpcCategory = value("bnpccategory").toUpperCase();
  if (bnpcCategory && !BNPC_CATEGORIES.has(bnpcCategory)) {
    error("bnpcCategory", "must be BASIC_NECESSITY or PRIME_COMMODITY.");
  } else if (bnpcEligible && !bnpcCategory) {
    error("bnpcCategory", "is required when bnpcEligible is TRUE.");
  }

  const tracksLots = ["true", "yes", "1"].includes(
    value("trackslots").toLowerCase(),
  );
  const rawQuantity = value("openingquantity");
  const openingQuantity = rawQuantity === "" ? 0 : Number(rawQuantity);
  if (
    !Number.isInteger(openingQuantity) ||
    openingQuantity < 0 ||
    openingQuantity > MAX_QUANTITY
  ) {
    error("openingQuantity", `must be a whole number from 0 to ${MAX_QUANTITY}.`);
  }

  const openingUnitCost = value("openingunitcost");
  if (openingUnitCost && !MONEY_PATTERN.test(openingUnitCost)) {
    error("openingUnitCost", "must have at most 2 decimal places and up to 7 digits before the decimal.");
  }
  const zeroCostReason = value("zerocostreason");
  if (
    openingQuantity > 0 &&
    !Number.isNaN(openingQuantity) &&
    !openingUnitCost
  ) {
    error("openingUnitCost", "is required when openingQuantity is greater than zero.");
  }
  if (
    openingQuantity > 0 &&
    MONEY_PATTERN.test(openingUnitCost) &&
    Number(openingUnitCost) === 0
  ) {
    if (zeroCostReason.length < 3 || zeroCostReason.length > 500) {
      error("zeroCostReason", "a zero-cost opening balance needs a reason of 3–500 characters.");
    }
  } else if (zeroCostReason && (zeroCostReason.length < 3 || zeroCostReason.length > 500)) {
    error("zeroCostReason", "must be 3–500 characters when provided.");
  }

  const reorderLevel = value("reorderlevel");
  if (reorderLevel) {
    const parsed = Number(reorderLevel);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > MAX_QUANTITY
    ) {
      error("reorderLevel", `must be a whole number from 0 to ${MAX_QUANTITY}.`);
    }
  }

  lengthCheck("openingreference", 200);
  lengthCheck("openinglotcode", 100);
  lengthCheck("openingsupplier", 160);

  const expiryDate = value("openingexpirydate");
  if (expiryDate && !isCalendarDate(expiryDate)) {
    error("openingExpiryDate", "must be a real date in YYYY-MM-DD format.");
  } else if (expiryDate && tracksLots && openingQuantity > 0 && expiryDate < today) {
    error("openingExpiryDate", `is expired as of the Manila date ${today}.`);
  }
  if (tracksLots && openingQuantity > 0) {
    if (!value("openinglotcode")) {
      error("openingLotCode", "is required for tracked opening stock.");
    }
    if (!expiryDate) {
      error("openingExpiryDate", "is required for tracked opening stock.");
    }
  }

  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/u.test(value("openinglotcode"))) {
    warning("openingLotCode", `"${value("openinglotcode")}" looks like spreadsheet scientific notation. Verify it against the printed lot/batch label; this checker will not infer the original code.`);
  }

  const noteCost = value("openingreference").match(
    /\b(?:actual\s+)?(?:unit\s+)?cost\s*(?:is\s+|[:=]\s*)?(?:PHP\s*|₱\s*)?(\d+(?:\.\d+)?)/iu,
  );
  if (noteCost && openingUnitCost && MONEY_PATTERN.test(openingUnitCost)) {
    if (Number(noteCost[1]) !== Number(openingUnitCost)) {
      warning("openingUnitCost", `the reference mentions cost ${noteCost[1]}, but the cost field is ${openingUnitCost}. Confirm the authoritative per-unit cost; do not silently round.`);
    }
  }
}

function printUsage() {
  process.stdout.write(
    "Manual opening-stock CSV checker (read-only)\n\n" +
      'Usage: node manual-checks/check-opening-stock-csv.mjs "path/to/file.csv"\n',
  );
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath || inputPath === "--help" || process.argv.length > 3) {
    printUsage();
    process.exitCode = inputPath === "--help" ? 0 : 2;
    return;
  }

  const filePath = resolve(inputPath);
  let buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    process.stderr.write(
      `Could not read CSV: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const errors = [];
  const warnings = [];
  if (buffer.byteLength > MAX_FILE_BYTES) {
    errors.push(`File is ${buffer.byteLength} bytes; the import screen accepts at most ${MAX_FILE_BYTES} bytes.`);
  }

  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    errors.push("File is not valid UTF-8 text. Save/export it as UTF-8 CSV.");
    printReport(filePath, 0, errors, warnings);
    process.exitCode = 1;
    return;
  }

  if (source.length > MAX_CSV_CHARACTERS) {
    errors.push(`CSV has more than ${MAX_CSV_CHARACTERS} characters.`);
  }
  if (errors.length) {
    printReport(filePath, 0, errors, warnings);
    process.exitCode = 1;
    return;
  }

  const document = parseCsv(source);
  errors.push(...document.errors);
  if (document.errors.length === 0) {
    const today = manilaDate();
    const seenSkus = new Set();
    const seenBarcodes = new Set();
    for (const row of document.rows) {
      checkCsvRow(row, errors, warnings, seenSkus, seenBarcodes, today);
    }
  }

  warnings.push(
    "This manual checker cannot query the destination database: existing SKU/barcode conflicts and destination tax settings still need checking in the app.",
  );
  printReport(filePath, document.rows.length, errors, warnings);
  process.exitCode = errors.length ? 1 : 0;
}

function printReport(filePath, rowCount, errors, warnings) {
  process.stdout.write(`CSV: ${filePath}\nData rows: ${rowCount}\n`);
  if (errors.length) {
    process.stdout.write(`\nERRORS (${errors.length})\n`);
    for (const message of errors) process.stdout.write(`- ${message}\n`);
  } else {
    process.stdout.write("\nNo format/schema errors found.\n");
  }
  if (warnings.length) {
    process.stdout.write(`\nREVIEW (${warnings.length})\n`);
    for (const message of warnings) process.stdout.write(`- ${message}\n`);
  }
  process.stdout.write(
    errors.length
      ? "\nResult: NOT READY. The app validates the whole file and should import no rows.\n"
      : "\nResult: FORMAT CHECK PASSED. This is not a guarantee of import; review warnings and try the app import.\n",
  );
}

await main();
