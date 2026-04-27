// Eighths-block horizontal context-usage bar shared by agent-footer and
// delegation-boxes so the two never drift. Each cell covers 8 eighths,
// so a 5-cell bar has 40 buckets (~2.5%/bucket); a 3-cell bar has 24
// buckets (~4%/bucket).

export const BAR_BLOCKS = ["░", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

export function renderBar(percent: number, width: number): string {
  const max = width * 8;
  const totalEighths = Math.max(0, Math.min(max, Math.round((percent / 100) * max)));
  let out = "";
  for (let i = 0; i < width; i++) {
    const cellEighths = Math.max(0, Math.min(8, totalEighths - i * 8));
    out += BAR_BLOCKS[cellEighths];
  }
  return out;
}
