/**
 * CSV generation for the dashboard exports.
 *
 * ── Why the escaping is this defensive ─────────────────────────────────────
 * `issue_summary` and `vehicle_registration` are free text that a manager types.
 * A cell beginning `=`, `+`, `-` or `@` is interpreted as a formula by Excel,
 * LibreOffice and Google Sheets, so a value like `=HYPERLINK("http://evil","x")`
 * becomes a live link or, on older Excel, a DDE execution. Prefixing such a value
 * with an apostrophe defuses it without altering what the user sees. This is the
 * standard CSV-export mitigation and it is applied to every cell, not just the
 * ones currently believed safe.
 *
 * ── Why the BOM is written ─────────────────────────────────────────────────
 * Without a UTF-8 byte-order mark, Excel on Windows reads a UTF-8 CSV as the
 * local codepage, which mangles any non-ASCII character. The BOM is invisible in
 * every other consumer and costs three bytes.
 */

const BOM = '\uFEFF';

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export type CsvCell = string | number | boolean | null | undefined;

/**
 * Escapes one field.
 *
 * Quoting is applied when the value contains a delimiter, a quote, a newline or
 * leading/trailing whitespace that would otherwise be trimmed by the reader.
 * Quotes inside the value are doubled, per RFC 4180.
 */
export function escapeCsvField(value: CsvCell): string {
  if (value === null || value === undefined) {
    return '';
  }

  let text = typeof value === 'boolean' ? String(value) : String(value);

  // Also strip control characters that would corrupt a row's line structure.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  const needsFormulaGuard = FORMULA_PREFIXES.includes(text.charAt(0));

  if (needsFormulaGuard) {
    text = `'${text}`;
  }

  const needsQuoting =
    needsFormulaGuard ||
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    // A tab is legal inside a quoted field but is treated as a column separator
    // by Excel in several locales, so its presence forces quoting. It is not
    // stripped: tabs occur in real maintenance descriptions and dropping them
    // would alter the text a reader sees.
    text.includes('\t') ||
    text !== text.trim();

  return needsQuoting ? `"${text.replace(/"/g, '""')}"` : text;
}

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => CsvCell;
};

/** Builds a complete CSV document from columns and rows. */
export function toCsv<T>(columns: ReadonlyArray<CsvColumn<T>>, rows: ReadonlyArray<T>): string {
  const header = columns.map((column) => escapeCsvField(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => escapeCsvField(column.value(row))).join(','));

  return [BOM + header, ...body].join('\r\n');
}

/**
 * `astar_remittances_2026-10-02.csv`
 *
 * The date is UTC so the filename matches the buckets the numbers came from,
 * regardless of who exports and when.
 */
export function csvFilename(prefix: string, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);

  return `astar_${prefix}_${stamp}.csv`;
}

/**
 * Triggers a browser download of a CSV string.
 *
 * Object URLs are revoked on the next tick: revoking synchronously races the
 * download in some browsers and produces an empty file.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => URL.revokeObjectURL(url), 0);
}