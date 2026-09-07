// Centralizes the SheetJS (xlsx) export pattern already established in VaultApp.tsx's own
// exportIncomeExpenditure/exportBalanceSheet/exportCashFlow/exportBudget -- one sheet per
// { name, rows } entry (rows include their own header row as rows[0]), auto column widths from
// the header, dynamic import (code-split, same as the existing exports), filename always ends
// .xlsx. New reports should build their data as arrays-of-arrays and call this instead of
// re-deriving the XLSX.* boilerplate each time.
export type ExcelSheet = { name: string; rows: (string | number)[][] };

export async function exportWorkbook(filename: string, sheets: ExcelSheet[]): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    if (sheet.rows.length === 0) continue;
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    const header = sheet.rows[0] ?? [];
    ws["!cols"] = header.map((h) => ({ wch: Math.max(12, String(h ?? "").length) }));
    // Sheet names are capped at 31 chars by the xlsx format itself.
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
}
