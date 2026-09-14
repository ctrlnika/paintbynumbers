/// <reference lib="webworker" />

export type PbnRegion = {
  x: number;
  y: number;
  color: number; // palette index
  r: number; // inscribed radius in px
};

export type PbnRequest = {
  width: number;
  height: number;
  pixels: ArrayBuffer; // RGBA
  colors: number;
  detail: number; // 0 = very smooth, 100 = keep detail
};

export type PbnResult = {
  type: "done";
  width: number;
  height: number;
  palette: [number, number, number][];
  preview: ArrayBuffer; // RGBA of quantised image
  edges: ArrayBuffer; // Uint8 mask, 1 = outline pixel
  regions: PbnRegion[];
};

export type PbnProgress = { type: "progress"; value: number; label: string };
export type PbnMessage = PbnProgress | PbnResult | { type: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function srgbToLinear(c: number) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function post(msg: PbnMessage, transfer?: Transferable[]) {
  if (transfer) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

function kmeans(samples: Float32Array, k: number, iterations = 14) {
  const n = samples.length / 3;
  const centroids = new Float32Array(k * 3);

  // k-means++ style seeding
  let seed = Math.floor(Math.random() * n);
  centroids[0] = samples[seed * 3]!;
  centroids[1] = samples[seed * 3 + 1]!;
  centroids[2] = samples[seed * 3 + 2]!;
  const best = new Float32Array(n).fill(Infinity);

  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dl = samples[i * 3]! - centroids[(c - 1) * 3]!;
      const da = samples[i * 3 + 1]! - centroids[(c - 1) * 3 + 1]!;
      const db = samples[i * 3 + 2]! - centroids[(c - 1) * 3 + 2]!;
      const d = dl * dl + da * da + db * db;
      if (d < best[i]!) best[i] = d;
      total += best[i]!;
    }
    let target = Math.random() * total;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      target -= best[i]!;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centroids[c * 3] = samples[pick * 3]!;
    centroids[c * 3 + 1] = samples[pick * 3 + 1]!;
    centroids[c * 3 + 2] = samples[pick * 3 + 2]!;
  }

  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);

  for (let iter = 0; iter < iterations; iter++) {
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const l = samples[i * 3]!;
      const a = samples[i * 3 + 1]!;
      const b = samples[i * 3 + 2]!;
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = l - centroids[c * 3]!;
        const da = a - centroids[c * 3 + 1]!;
        const db = b - centroids[c * 3 + 2]!;
        const d = dl * dl + da * da + db * db;
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }
      sums[bestIdx * 3] += l;
      sums[bestIdx * 3 + 1] += a;
      sums[bestIdx * 3 + 2] += b;
      counts[bestIdx]!++;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c]! === 0) continue;
      centroids[c * 3] = sums[c * 3]! / counts[c]!;
      centroids[c * 3 + 1] = sums[c * 3 + 1]! / counts[c]!;
      centroids[c * 3 + 2] = sums[c * 3 + 2]! / counts[c]!;
    }
    if (iter % 4 === 0) {
      post({
        type: "progress",
        value: 10 + (iter / iterations) * 35,
        label: "Mixing the palette",
      });
    }
  }
  return centroids;
}

function majorityFilter(labels: Uint8Array, w: number, h: number, k: number) {
  const out = new Uint8Array(labels.length);
  const tally = new Int32Array(k);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      tally.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          tally[labels[yy * w + xx]!]!++;
        }
      }
      let bestIdx = labels[y * w + x]!;
      let bestCount = -1;
      for (let c = 0; c < k; c++) {
        if (tally[c]! > bestCount) {
          bestCount = tally[c]!;
          bestIdx = c;
        }
      }
      out[y * w + x] = bestIdx;
    }
  }
  return out;
}

ctx.onmessage = (event: MessageEvent<PbnRequest>) => {
  try {
    const { width: w, height: h, colors, detail } = event.data;
    const data = new Uint8ClampedArray(event.data.pixels);
    const px = w * h;

    post({ type: "progress", value: 5, label: "Reading your image" });

    // --- sample pixels in Lab space
    const maxSamples = 24000;
    const step = Math.max(1, Math.floor(px / maxSamples));
    const sampleCount = Math.floor((px + step - 1) / step);
    const samples = new Float32Array(sampleCount * 3);
    let s = 0;
    for (let i = 0; i < px; i += step) {
      const lab = rgbToLab(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
      samples[s * 3] = lab[0];
      samples[s * 3 + 1] = lab[1];
      samples[s * 3 + 2] = lab[2];
      s++;
    }

    const k = Math.max(2, Math.min(30, colors));
    const centroids = kmeans(samples.subarray(0, s * 3), k);

    post({ type: "progress", value: 50, label: "Sorting every pixel" });

    // --- assign every pixel
    let labels = new Uint8Array(px);
    const sumR = new Float64Array(k);
    const sumG = new Float64Array(k);
    const sumB = new Float64Array(k);
    const counts = new Int32Array(k);
    for (let i = 0; i < px; i++) {
      const r = data[i * 4]!;
      const g = data[i * 4 + 1]!;
      const b = data[i * 4 + 2]!;
      const lab = rgbToLab(r, g, b);
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = lab[0] - centroids[c * 3]!;
        const da = lab[1] - centroids[c * 3 + 1]!;
        const db = lab[2] - centroids[c * 3 + 2]!;
        const d = dl * dl + da * da + db * db;
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }
      labels[i] = bestIdx;
      sumR[bestIdx] += r;
      sumG[bestIdx] += g;
      sumB[bestIdx] += b;
      counts[bestIdx]!++;
    }

    post({ type: "progress", value: 65, label: "Smoothing the shapes" });

    // --- smooth: more passes when detail is low
    const passes = Math.max(0, Math.round(4 - (detail / 100) * 4));
    for (let p = 0; p < passes; p++) labels = majorityFilter(labels, w, h, k);

    // --- palette (average true colour per cluster, in display order by lightness)
    const rawPalette: [number, number, number][] = [];
    for (let c = 0; c < k; c++) {
      if (counts[c]! === 0) {
        rawPalette.push([0, 0, 0]);
      } else {
        rawPalette.push([
          Math.round(sumR[c]! / counts[c]!),
          Math.round(sumG[c]! / counts[c]!),
          Math.round(sumB[c]! / counts[c]!),
        ]);
      }
    }
    const order = rawPalette
      .map((c, i) => ({ i, lum: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], used: counts[i]! }))
      .filter((e) => e.used > 0)
      .sort((a, b) => a.lum - b.lum);
    const remap = new Uint8Array(k);
    const palette: [number, number, number][] = [];
    order.forEach((entry, newIdx) => {
      remap[entry.i] = newIdx;
      palette.push(rawPalette[entry.i]!);
    });
    for (let i = 0; i < px; i++) labels[i] = remap[labels[i]!]!;
    const kUsed = palette.length;

    // --- quantised preview
    const preview = new Uint8ClampedArray(px * 4);
    for (let i = 0; i < px; i++) {
      const c = palette[labels[i]!]!;
      preview[i * 4] = c[0];
      preview[i * 4 + 1] = c[1];
      preview[i * 4 + 2] = c[2];
      preview[i * 4 + 3] = 255;
    }

    post({ type: "progress", value: 78, label: "Tracing the outlines" });

    // --- edges
    const edges = new Uint8Array(px);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = labels[i]!;
        if ((x + 1 < w && labels[i + 1]! !== l) || (y + 1 < h && labels[i + w]! !== l)) {
          edges[i] = 1;
        }
      }
    }

    // --- distance to nearest edge (chamfer, two passes)
    const dist = new Float32Array(px);
    const INF = 1e9;
    for (let i = 0; i < px; i++) dist[i] = edges[i] === 1 ? 0 : INF;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let d = dist[i]!;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) d = Math.min(d, 0);
        if (x > 0) d = Math.min(d, dist[i - 1]! + 1);
        if (y > 0) d = Math.min(d, dist[i - w]! + 1);
        if (x > 0 && y > 0) d = Math.min(d, dist[i - w - 1]! + 1.414);
        if (x + 1 < w && y > 0) d = Math.min(d, dist[i - w + 1]! + 1.414);
        dist[i] = d;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let d = dist[i]!;
        if (x + 1 < w) d = Math.min(d, dist[i + 1]! + 1);
        if (y + 1 < h) d = Math.min(d, dist[i + w]! + 1);
        if (x + 1 < w && y + 1 < h) d = Math.min(d, dist[i + w + 1]! + 1.414);
        if (x > 0 && y + 1 < h) d = Math.min(d, dist[i + w - 1]! + 1.414);
        dist[i] = d;
      }
    }

    post({ type: "progress", value: 88, label: "Numbering the regions" });

    // --- connected components, pick the most interior pixel of each
    const comp = new Int32Array(px).fill(-1);
    const stack = new Int32Array(px);
    const regions: PbnRegion[] = [];
    let compId = 0;
    for (let start = 0; start < px; start++) {
      if (comp[start] !== -1) continue;
      const label = labels[start]!;
      let sp = 0;
      stack[sp++] = start;
      comp[start] = compId;
      let size = 0;
      let bestD = -1;
      let bestPix = start;
      while (sp > 0) {
        const i = stack[--sp]!;
        size++;
        if (dist[i]! > bestD) {
          bestD = dist[i]!;
          bestPix = i;
        }
        const x = i % w;
        const y = (i / w) | 0;
        if (x > 0 && comp[i - 1] === -1 && labels[i - 1] === label) {
          comp[i - 1] = compId;
          stack[sp++] = i - 1;
        }
        if (x + 1 < w && comp[i + 1] === -1 && labels[i + 1] === label) {
          comp[i + 1] = compId;
          stack[sp++] = i + 1;
        }
        if (y > 0 && comp[i - w] === -1 && labels[i - w] === label) {
          comp[i - w] = compId;
          stack[sp++] = i - w;
        }
        if (y + 1 < h && comp[i + w] === -1 && labels[i + w] === label) {
          comp[i + w] = compId;
          stack[sp++] = i + w;
        }
      }
      compId++;
      if (size >= 60 && bestD >= 4) {
        regions.push({
          x: bestPix % w,
          y: (bestPix / w) | 0,
          color: label,
          r: bestD,
        });
      }
    }

    void kUsed;
    post({ type: "progress", value: 98, label: "Almost there" });

    const result: PbnResult = {
      type: "done",
      width: w,
      height: h,
      palette,
      preview: preview.buffer as ArrayBuffer,
      edges: edges.buffer as ArrayBuffer,
      regions,
    };
    post(result, [result.preview, result.edges]);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : "Processing failed" });
  }
};
