// Compatibility shim: the printer lives in src/printers/ now. Existing code
// (print.html, test.html) still imports from './printer.js', so we re-export
// the Phomemo client plus the width constants used across the app.
//
// The booth itself uses connectPrinter() from ./printers/ for the multi-type
// auto-detect flow.

export { PhomemoPrinter } from './printers/phomemo.js';

export const HEAD_WIDTH_DOTS = 576;
export const DEFAULT_PRINT_WIDTH_DOTS = 552;
