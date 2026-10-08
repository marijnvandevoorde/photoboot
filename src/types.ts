// Shared shapes passed between the capture, print and template modules.

// Packed 1-bit image for the printer: MSB first, 1 = black dot.
export interface Raster {
  bitmap: Uint8Array;
  widthDots: number;
  heightDots: number;
}

// Anything a photo can be drawn from.
export type ImageSource = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | ImageBitmap;

export interface Look {
  style: string;
  twist: string;
}

// A resolved template (see templates.ts): layout of the sticker around the shots.
export interface Template {
  label: string;
  photoWidth: (stickerWidth: number) => number;
  topPadding: number;
  bottomPadding: number;
  gap: number;
  buildHeader: ((width: number) => HTMLCanvasElement) | null;
  buildFooter: ((width: number) => HTMLCanvasElement) | null;
}

export interface ToneOptions {
  photo?: boolean;
  gamma?: number;
  clip?: number;
  sharpen?: number;
  denoise?: number;
  outline?: number;
}

export interface RasterOptions extends ToneOptions {
  dither?: string;
  noise?: number;
  period?: number;
}
