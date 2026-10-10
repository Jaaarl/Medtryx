export type ReceiptCsvRow = Record<string, string> & {
  originaldescription: string;
  draftid: string;
  rearrangedname: string;
  sourcequantity: string;
  sourceunitcost: string;
  sourcelinetotal: string;
  sourcelot: string;
  sourceexpiry: string;
  quantity: string;
  unitcost: string;
  lotcode: string;
  expirydate: string;
  supplier: string;
  reference: string;
  matchstatus: string;
  suggestedproductid: string;
  suggestedproductname: string;
  suggestedproductsku: string;
  selectedproductid: string;
  sku: string;
  unit: string;
  sellingprice: string;
  taxclass: string;
  producttype: string;
  issceligible: string;
  ispwdeligible: string;
  bnpceligible: string;
  bnpccategory: string;
  trackslots: string;
  conversionrecommended: string;
  unitsperpackage: string;
  conversionconfidence: string;
  conversionreason: string;
  conversionapproved: string;
  zerocostreason: string;
};

export type ReceiptCsvDocument = {
  headers: string[];
  rows: ReceiptCsvRow[];
};

const requiredHeaders = [
  "originaldescription",
  "draftid",
  "rearrangedname",
  "quantity",
  "unitcost",
  "matchstatus",
  "selectedproductid",
  "conversionapproved",
];

const currentReceiptHeaders = [
  "originaldescription",
  "draftid",
  "rearrangedname",
  "sourcequantity",
  "sourceunitcost",
  "sourcelinetotal",
  "sourcelot",
  "sourceexpiry",
  "quantity",
  "unitcost",
  "lotcode",
  "expirydate",
  "supplier",
  "reference",
  "matchstatus",
  "suggestedproductid",
  "suggestedproductname",
  "suggestedproductsku",
  "selectedproductid",
  "sku",
  "unit",
  "sellingprice",
  "taxclass",
  "producttype",
  "issceligible",
  "ispwdeligible",
  "bnpceligible",
  "bnpccategory",
  "trackslots",
  "conversionrecommended",
  "unitsperpackage",
  "conversionconfidence",
  "conversionreason",
  "conversionapproved",
  "zerocostreason",
];

export function parseReceiptCsv(source: string): ReceiptCsvDocument {
  if (source.length > 200_000)
    throw new Error("The receipt CSV is larger than 200 KB.");

  const csv = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const records: string[][] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  const finishField = () => {
    cells.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRecord = () => {
    finishField();
    if (cells.some((cell) => cell.trim() !== "")) records.push(cells);
    cells = [];
  };

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
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
      }
      continue;
    }

    if (closedQuote && character !== "," && character !== "\n")
      throw new Error("The receipt CSV has an invalid quoted field.");
    if (character === '"') {
      if (field.trim() !== "")
        throw new Error("The receipt CSV has an invalid quoted field.");
      field = "";
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRecord();
    } else {
      field += character;
    }
  }

  if (quoted)
    throw new Error("The receipt CSV has an unfinished quoted field.");
  if (field !== "" || cells.length > 0) finishRecord();

  const sourceHeaders = records.shift();
  if (!sourceHeaders?.length)
    throw new Error("The receipt CSV does not contain a header row.");
  const sourceHeaderNames = sourceHeaders.map((header) =>
    header.trim().toLowerCase(),
  );
  if (new Set(sourceHeaderNames).size !== sourceHeaderNames.length)
    throw new Error("The receipt CSV contains duplicate column names.");
  const missingHeaders = requiredHeaders.filter(
    (header) => !sourceHeaderNames.includes(header),
  );
  if (missingHeaders.length)
    throw new Error("Choose a receipt review CSV with the expected columns.");
  const headers = [
    ...sourceHeaderNames,
    ...currentReceiptHeaders.filter(
      (header) => !sourceHeaderNames.includes(header),
    ),
  ];

  const rows = records.map((record) => {
    if (record.length > sourceHeaderNames.length)
      throw new Error("A receipt CSV row has more values than its header.");
    const values = {
      originaldescription: "",
      draftid: "",
      rearrangedname: "",
      sourcequantity: "",
      sourceunitcost: "",
      sourcelinetotal: "",
      sourcelot: "",
      sourceexpiry: "",
      quantity: "",
      unitcost: "",
      lotcode: "",
      expirydate: "",
      supplier: "",
      reference: "",
      matchstatus: "NEW_PRODUCT",
      suggestedproductid: "",
      suggestedproductname: "",
      suggestedproductsku: "",
      selectedproductid: "",
      sku: "",
      unit: "",
      sellingprice: "",
      taxclass: "",
      producttype: "",
      issceligible: "FALSE",
      ispwdeligible: "FALSE",
      bnpceligible: "FALSE",
      bnpccategory: "",
      trackslots: "FALSE",
      conversionrecommended: "FALSE",
      unitsperpackage: "",
      conversionconfidence: "LOW",
      conversionreason: "",
      conversionapproved: "FALSE",
      zerocostreason: "",
      ...Object.fromEntries(
        sourceHeaderNames.map((header, index) => [header, record[index] ?? ""]),
      ),
    } as ReceiptCsvRow;
    return {
      ...values,
      matchstatus: values.matchstatus || "NEW_PRODUCT",
      issceligible: values.issceligible || "FALSE",
      ispwdeligible: values.ispwdeligible || "FALSE",
      bnpceligible: values.bnpceligible || "FALSE",
      trackslots: values.trackslots || "FALSE",
      conversionrecommended: values.conversionrecommended || "FALSE",
      conversionconfidence: values.conversionconfidence || "LOW",
      conversionapproved: values.conversionapproved || "FALSE",
    };
  });
  if (!rows.length) throw new Error("The receipt CSV has no line items.");
  if (rows.length > 500)
    throw new Error("A receipt can contain no more than 500 line items.");

  return { headers, rows };
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function serializeReceiptCsv(
  headers: string[],
  rows: ReceiptCsvRow[],
): string {
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) =>
      headers.map((header) => csvCell(row[header] ?? "")).join(","),
    ),
  ].join("\r\n");
}
