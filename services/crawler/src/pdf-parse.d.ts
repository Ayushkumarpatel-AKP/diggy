// Minimal ambient types for `pdf-parse`, which ships no bundled declarations.
declare module 'pdf-parse' {
  export interface PdfParseData {
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    text: string;
    version: string;
  }

  function pdfParse(
    data: Buffer | Uint8Array | ArrayBuffer,
    options?: Record<string, unknown>,
  ): Promise<PdfParseData>;

  export default pdfParse;
}
