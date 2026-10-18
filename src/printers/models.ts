// Printer models: what the booth knows about each one, so picking (or
// auto-detecting) a printer sets its paper width and resolution. The host
// can still override the width and tear margin in settings.
//
// `family` is the driver (see index.ts). `names` are Bluetooth name
// prefixes, matched longest first, so "M02S" wins over "M02". Families
// share service UUIDs, so the name is what picks the driver. `variant`
// tells a driver which dialect of its protocol the model speaks.
// `verified`: printed on real hardware by us or a contributor. The others
// follow their family's protocol as documented by open-source drivers
// (see README: Supported printers) but haven't been tried yet.

export interface PrinterModel {
  id: string;
  label: string;
  family: string;
  names: string[];
  // Sold under names we can't predict: the picker lists every device.
  anyName?: boolean;
  dpi: number;
  headWidthDots: number; // dots the head can print
  widthDots: number; // default print width: the head minus the paper margins
  tearMm: number; // from the print head to the tear edge: blank paper after a print
  variant?: string;
  verified?: boolean;
}

export const MODELS: PrinterModel[] = [
  // ---------- Phomemo ----------
  {
    id: 'phomemo-p2s',
    label: 'Phomemo P2 / P2S',
    family: 'phomemo',
    names: ['P2'],
    dpi: 300,
    headWidthDots: 576,
    widthDots: 552,
    // 6 mm was barely enough on a P2S.
    tearMm: 10,
    verified: true,
  },
  {
    id: 'phomemo-m02s',
    label: 'Phomemo M02S',
    family: 'phomemo',
    names: ['M02S', 'Mr.in_M02S'],
    dpi: 300,
    headWidthDots: 576,
    widthDots: 552,
    tearMm: 10,
  },
  {
    id: 'phomemo-m02pro',
    label: 'Phomemo M02 Pro',
    family: 'phomemo',
    names: ['M02PRO', 'M02 Pro', 'sandymaro'],
    dpi: 300,
    headWidthDots: 624,
    widthDots: 600,
    tearMm: 10,
  },
  {
    id: 'phomemo-m02',
    label: 'Phomemo M02 / M02X / T02 / Memoking',
    family: 'phomemo',
    names: ['M02', 'Mr.in', 'MR2', 'KP-Q1', 'T02', 'Q02E', 'C02E', 'Phomemo'],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 10,
  },
  {
    id: 'phomemo-m03',
    label: 'Phomemo M03',
    family: 'phomemo',
    names: ['M03'],
    dpi: 203,
    headWidthDots: 432,
    widthDots: 432,
    tearMm: 10,
  },
  {
    id: 'phomemo-m110',
    label: 'Phomemo M110 / M120 (labels)',
    family: 'phomemo',
    names: [
      'M110',
      'M120',
      'M102',
      'M002',
      'Q002',
      'Q009',
      'Q011',
      'Q026',
      'Q034',
      'Q042',
      'Q043',
      'Q045',
      'Q061',
      'Q062',
      'Q119',
      'Q120',
      'Q192',
      'Q194',
      'Q199',
      'Q244',
      'Q274',
      'Q306',
      'Q317',
      'Q431',
      'Q437',
      'Q451',
      'Q468',
      'Q481',
      'Q485',
      'Q524',
      'Q592',
      'Q593',
    ],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 320, // 40 mm labels
    tearMm: 0, // it moves on to the next label by itself
    variant: 'label',
  },
  {
    id: 'phomemo-m220',
    label: 'Phomemo M220 / M221 (labels)',
    family: 'phomemo',
    names: ['M220', 'M221', 'Q054', 'Q155'],
    dpi: 203,
    headWidthDots: 576,
    widthDots: 560,
    tearMm: 0,
    variant: 'label',
  },

  // ---------- Cat printers (iPrint, Tiny Print, Fun Print) ----------
  {
    id: 'cat-gb',
    label: 'Cat printer GB01–GB05 / GT01 / X5–X8 / LY0x',
    family: 'cat',
    names: [
      'GB01',
      'GB02',
      'GB03',
      'GB04',
      'GB05',
      'GT01',
      'GT02',
      'GT04',
      'GT08',
      'GT09',
      'LY01',
      'LY02',
      'LY03',
      'LY05',
      'X5',
      'X6',
      'X7',
      'X8',
      'X2H',
      'X103H',
      'SC03',
      'MXTP',
    ],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 12,
  },
  {
    id: 'cat-mx',
    label: 'Cat printer MX05–MX13 / YT01 / PD01',
    family: 'cat',
    names: [
      'MX05',
      'MX06',
      'MX08',
      'MX09',
      'MX10',
      'MX11',
      'MX12',
      'MX13',
      'MXW009',
      'MXW010',
      'YT01',
      'YT02',
      'PD01',
      'BQ0',
    ],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 12,
    variant: 'mx',
  },
  {
    id: 'cat-ly10',
    label: 'Cat printer LY10 / LY11 / LP100',
    family: 'cat',
    names: ['LY10', 'LY11', 'LP100', 'JXM800'],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 12,
    variant: 'prefixed',
  },
  {
    id: 'mxw01',
    label: 'MXW01 / Flying Tiger / StickerMate (Fun Print)',
    family: 'mxw01',
    names: [
      'MXW01',
      'MXW13',
      'MXW18',
      'MXW-W5',
      'V5X',
      'C17',
      'STICKERMATE',
      'INSTANTPRINTPLUS',
      'FLYINGTIGER',
      'AC695X_PRINT',
      'JK01',
      'PORTABLEPRINTER',
      'KERUI',
      'BH03',
      'Q15',
      'Q17',
    ],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 12,
  },

  // ---------- LuckJingle / LuckPrinter SDK ----------
  {
    id: 'luck-pocket',
    label: 'LuckJingle D1 / L1 / S1, Crafts & Co 3128 (Action), Lidl pocket printer',
    family: 'luck',
    names: [
      'LuckP_D1',
      'LuckP_L1',
      'LuckP_L3',
      'LuckP_S1',
      'LUCKJINGLE',
      'DP_D1',
      'DP_S1',
      'DP-L1',
      'C&Co',
      'Seznik',
      'Mini Pocket Printer',
      'SILVERCREST',
      'QIRUI',
    ],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 10,
    variant: 'lujiang',
  },
  {
    id: 'fichero-pocket',
    label: 'Fichero Mini Pocket Printer (Action)',
    family: 'luck',
    names: [],
    anyName: true,
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 10,
    variant: 'lujiang',
  },
  {
    id: 'peripage-a6',
    label: 'PeriPage A6',
    family: 'luck',
    names: ['PeriPage_', 'PeriPage', 'PPG_'],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 9,
    variant: 'aiyin',
  },
  {
    id: 'peripage-a6plus',
    label: 'PeriPage A6+',
    family: 'luck',
    names: ['PeriPage+'],
    dpi: 304,
    headWidthDots: 576,
    widthDots: 576,
    tearMm: 9,
    variant: 'aiyin',
  },
  {
    id: 'marklife-p50',
    label: 'Marklife P50',
    family: 'luck',
    names: ['P50', 'LP50'],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 10,
    variant: 'marklife',
  },

  // ---------- Paperang ----------
  {
    id: 'paperang-p1',
    label: 'Paperang P1',
    family: 'paperang',
    names: ['Paperang', 'PAPERANG', 'MiaoMiaoJi'],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 15,
  },
  {
    id: 'paperang-p2',
    label: 'Paperang P2 / P2S',
    family: 'paperang',
    names: ['Paperang_P2', 'Paperang P2'],
    dpi: 300,
    headWidthDots: 576,
    widthDots: 576,
    tearMm: 15,
  },

  // ---------- Niimbot ----------
  {
    id: 'niimbot-b1',
    label: 'Niimbot B1 (labels)',
    family: 'niimbot',
    names: ['B1-', 'B1_'],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 0,
    variant: 'b1',
  },
  {
    id: 'niimbot-b21',
    label: 'Niimbot B21 / B21S (labels)',
    family: 'niimbot',
    names: ['B21'],
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 0,
    variant: 'b21',
  },

  // ---------- Generic ESC/POS ----------
  {
    id: 'escpos-58',
    label: 'Receipt printer 58 mm (PT-210, MTP-II, …)',
    family: 'escpos',
    names: ['MTP-', 'MPT-', 'PT-210', 'PT210', 'MP210', 'RPP02', 'BlueTooth Printer', 'Printer001'],
    anyName: true,
    dpi: 203,
    headWidthDots: 384,
    widthDots: 384,
    tearMm: 12,
  },
  {
    id: 'escpos-80',
    label: 'Receipt printer 80 mm',
    family: 'escpos',
    names: ['MPT-3', 'MTP-3'],
    anyName: true,
    dpi: 203,
    headWidthDots: 576,
    widthDots: 576,
    tearMm: 12,
  },
];

// For a printer we don't know: generous rather than a sticker cut short.
export const DEFAULT_TEAR_MM = 10;

export function modelById(id: string): PrinterModel | null {
  return MODELS.find((m) => m.id === id) ?? null;
}

// The model a Bluetooth name belongs to, within `family` when given.
export function modelForName(name: string, family?: string): PrinterModel | null {
  let best: PrinterModel | null = null;
  let bestLength = 0;
  const upper = name.toUpperCase();
  for (const model of MODELS) {
    if (family && model.family !== family) continue;
    for (const prefix of model.names) {
      if (prefix.length > bestLength && upper.startsWith(prefix.toUpperCase())) {
        best = model;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

// Every name prefix of a family, for the picker.
export function familyNames(family: string): string[] {
  return [...new Set(MODELS.filter((m) => m.family === family).flatMap((m) => m.names))];
}

// What picking or connecting `model` changes: its resolution always, its
// width unless the host chose one by hand.
export function settingsFor(
  model: PrinterModel,
  { paperWidthAuto }: { paperWidthAuto: boolean }
): { dotsPerMm: number; paperWidthDots?: number } {
  const dotsPerMm = Math.round((model.dpi / 25.4) * 10) / 10;
  return paperWidthAuto ? { dotsPerMm, paperWidthDots: model.widthDots } : { dotsPerMm };
}
