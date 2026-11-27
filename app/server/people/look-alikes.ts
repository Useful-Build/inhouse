// The look-alike table for server/people/fold.ts: characters that look like Latin letters, from Unicode TR39's
// confusables data (https://www.unicode.org/Public/security/latest/confusables.txt, version 18.0.0, dated 2026-08-06,
// read 2026-11-27). Generated, never edited by hand. Each key is a run of the characters whose prototype is the key.
//
// How it was built: every `MA` line with one source character whose prototype, lowercased, is ASCII letters only.
// A source is kept only when it can reach the table at all, that is when fold.ts's earlier steps (NFKC, lowercase, NFD
// with marks removed, NFC) leave it unchanged; an ASCII letter mapped to itself is dropped. The map is closed: capital
// M's prototype lowercases to `m`, and `m`'s own prototype is `rn`, so every source that ends at `m` maps to `rn`. Every
// value is then a fixed point (fold.test.ts checks it), which keeps the fold idempotent.
//
// Not every line of TR39: sources whose prototype is a digit, punctuation or another script are left out, since only
// the instruction words (ASCII) are compared on look-alikes. Names in any script still fold the same way on both sides.

/** Prototype (lowercase ASCII) to the characters that look like it. */
export const LOOK_ALIKE_SOURCES: Readonly<Record<string, string>> = {
  a: '\u0251\u03B1\u0430\u15C5\u237A\uA4EE\uAB64\u{102A0}\u{16F40}\u{1DF5A}',
  aa: '\uA733',
  ae: '\u00E6\u04D5',
  ao: '\uA735',
  ar: '\u{1F707}',
  au: '\uA737',
  av: '\uA739\uA73B',
  ay: '\uA73D',
  b: '\u07D5\u1472\u15AF\u15F7\uA4D0\uA557\u{10282}\u{102A1}\u{10301}\u{1031C}\u{1D207}',
  c: '\u0441\u1004\u105A\u1C83\u1D04\u2CA5\uA4DA\uABAF\u{102A2}\u{10302}\u{1043D}\u{1051B}\u{118E9}\u{118F2}\u{1D134}\u{1F74C}',
  co: '\uAB43',
  d: '\u0501\u146F\u15DE\u15EA\uA4D2\uA4D3\u{1018B}',
  dz: '\u02A3',
  e: '\u0435\u04BD\u212E\u22FF\u2D39\uA4F0\uA5CB\uAB32\u{10286}\u{1DF81}',
  f: '\u0192\u0284\u0584\u07D3\u15B4\u1E9D\uA4DD\uA799\uAB35\u{1017E}\u{10287}\u{102A5}\u{10525}\u{118C2}\u{1D213}',
  g: '\u018D\u0261\u0581\u1D83\uA4D6',
  h: '\u04BB\u0570\u157C\uA4E7\u{102CF}',
  i: '\u00A1\u0131\u0269\u026A\u03B9\u0456\u0582\u2373\u2C93\uA647\uAB75\u{118C3}',
  ie: '\u{1DF5D}',
  j: '\u0237\u03F3\u0458\u0575\u148D\uA4D9',
  k: '\u16D5\uA4D7\u{10518}',
  l: '1|\u01C0\u04CF\u05C0\u05D5\u05DF\u0627\u0661\u06F1\u07CA\u0964\u104A\u14AA\u16C1\u16D0\u21BF\u2223\u23FD\u2502\u2503\u2D4A\u2D4F\uA4E1\uA4F2\uA56F\uA781\uA7FE\uA830\uA8CE\uAA5D\u{1028A}\u{10309}\u{10320}\u{1050E}\u{10526}\u{10926}\u{10C3E}\u{10CFA}\u{11047}\u{110C0}\u{11141}\u{111C5}\u{113D4}\u{1144B}\u{115C5}\u{11641}\u{11C41}\u{11DDA}\u{11DE1}\u{16D63}\u{16F16}\u{16F28}\u{1D100}\u{1D22A}\u{1D377}\u{1E141}\u{1E8C7}\u{1ED01}',
  ll: '\u01C1\u05F0\u0965\u104B\u2016\u2225\uA8CF\u{11048}\u{110C1}\u{11142}\u{111C6}\u{113D5}\u{1144C}\u{11642}\u{11C42}\u{1D262}',
  lll: '\uA516',
  ls: '\u02AA',
  lt: '\u20B6',
  lz: '\u02AB',
  n: '\u0578\u057C\uA4E0\u{10513}\u{11ABE}',
  o: '0\u03BF\u03C3\u03ED\u043E\u0585\u05E1\u0647\u0665\u06BE\u06C1\u06D5\u06F5\u07C0\u07CB\u0840\u0966\u09E6\u0A66\u0AE6\u0B20\u0B66\u0BE6\u0C66\u0CE6\u0D20\u0D66\u0E50\u0ED0\u101D\u1040\u10FF\u110B\u11BC\u12D0\u17E0\u1A45\u1A80\u1A90\u1C82\u1D0F\u1D11\u2C9F\u2D54\u3007\uA4F3\uAB3D\u{10292}\u{102AB}\u{1030F}\u{1042C}\u{104EA}\u{10516}\u{1092C}\u{10C17}\u{10D07}\u{11124}\u{114D0}\u{118C8}\u{118D7}\u{118E0}\u{11DE0}\u{16AE9}\u{1E140}\u{1E2F0}',
  oe: '\u0153',
  oi: '\u{1DF5E}',
  oo: '\u1147\u11EE\u221E\uA699\uA74F',
  ou: '\u{1DF5F}',
  oy: '\u0479',
  p: '\u00FE\u01BF\u03C1\u03F8\u0440\u146D\u2374\u2CA3\u2CCF\uA4D1\u{10295}',
  q: '\u051B\u0563\u0566\u2D55',
  qe: '\u{1F700}',
  r: '\u0433\u1587\u1D26\u2C85\uA4E3\uAB47\uAB48\uAB81\u{16A19}\u{16F35}\u{1D216}',
  rn: 'm\u0560\u15F0\u16D6\uA4DF\u{102B0}\u{10311}\u{10C21}\u{11700}\u{118E3}',
  rnb: '\u{1F76B}',
  s: '\u01BD\u0455\u0D1F\u10FD\uA4E2\uA576\uA731\uABAA\u{10296}\u{10448}\u{118C1}\u{16AD6}\u{16F3A}',
  sss: '\u{1F75C}',
  t: '\u07E0\u22A4\u27D9\u3112\u4E05\uA4D4\uA50B\u{10297}\u{102B1}\u{10315}\u{16F0A}\u{1D373}\u{1F768}',
  tf: '\uA777',
  th: '\u{1DF64}',
  ts: '\u02A6',
  u: '\u028B\u03C5\u057D\u1200\u144C\u1D1C\u222A\u22C3\uA4F4\uA79F\uAB4E\uAB52\u{104F6}\u{118D8}\u{16F42}',
  ue: '\u1D6B',
  uo: '\uAB63',
  v: '\u03BD\u0475\u05D8\u0667\u06F7\u142F\u1D20\u2228\u22C1\u2D38\uA4E6\uA6DF\uABA9\u{1051D}\u{10C1F}\u{11706}\u{118C0}\u{16F08}\u{1CEFC}\u{1D20D}\u{1E145}',
  vb: '\u{1F76C}',
  w: '\u026F\u0448\u0461\u051D\u0561\u1D21\u29E2\u2CBD\uA4EA\uA7FA\uAB83\uABA4\u{1170A}\u{1170E}\u{1170F}\u{118E6}\u{118EF}\u{1D20C}\u{1DF7D}',
  wh: '\u{1DF65}',
  x: '\u00D7\u0445\u1541\u157D\u166D\u166E\u16B7\u1763\u1CF5\u2573\u292B\u292C\u2A2F\u2D5D\uA4EB\u{10290}\u{102B4}\u{10317}\u{10322}\u{10527}\u{10C13}\u{10CC2}\u{10CFC}\u{118EC}',
  y: '\u0263\u028F\u03B3\u0443\u04AF\u07CC\u10E7\u1D8C\u1EFF\u2CA9\u311A\u4E2B\uA4EC\uAB5A\u{102B2}\u{10C20}\u{118C4}\u{118DC}\u{16F43}',
  z: '\u1D22\u2C6C\u2C8D\u2D2D\uA4DC\uA6C9\uAB93\u{102F5}\u{10507}\u{118E5}\u{11ABC}',
}
