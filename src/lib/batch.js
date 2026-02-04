export function parseLines(textBody, { maxLines }) {
  const raw = textBody.split(/\r?\n/);
  const out = [];
  for (const line of raw) {
    if (out.length >= maxLines) break;
    const v = line.trim();
    if (!v) continue;
    if (v.startsWith("#")) continue;
    out.push(v);
  }
  return out;
}

export function splitBatches(items, batchSize) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

