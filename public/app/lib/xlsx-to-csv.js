// Convert the first sheet of an .xlsx workbook to CSV text (for the optional
// driver-preferences upload, so HR can provide it as xlsx instead of CSV).
import * as XLSX from '../../vendor/xlsx.mjs';

export function xlsxFirstSheetToCsv(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The workbook has no readable sheet.');
  return XLSX.utils.sheet_to_csv(ws);
}
