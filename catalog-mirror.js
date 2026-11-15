/**
 * Resolve a Google Sheets catalogue mirror action without mutating the sheet.
 * Sheet ranges passed to this helper start at row 2, so returned row numbers
 * are one-based Google Sheets row numbers (not zero-based array indexes).
 */
export function resolveCatalogMirrorAction(rows, sku) {
  const target = String(sku ?? "").trim().toUpperCase();
  if (!target) return { action: "INVALID", rowNumbers: [] };

  const rowNumbers = [];
  for (let index = 0; index < (Array.isArray(rows) ? rows.length : 0); index++) {
    const candidate = String(rows[index]?.[0] ?? "").trim().toUpperCase();
    if (candidate && candidate === target) rowNumbers.push(index + 2);
  }

  if (rowNumbers.length > 1) return { action: "DUPLICATE", rowNumbers };
  if (rowNumbers.length === 1) return { action: "UPDATE", rowNumber: rowNumbers[0] };
  return { action: "APPEND", rowNumbers: [] };
}
