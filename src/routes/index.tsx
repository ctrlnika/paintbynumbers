import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ImagePlus, Loader2, RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import type { PbnMessage, PbnRegion, PbnRequest } from "@/workers/pbn.worker";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Paint by Numbers Maker — Turn Any Photo Into a Painting Kit" },
      {
        name: "description",
        content:
          "Upload a photo, pick how many colours you want, and get a numbered outline plus a colour key you can download and paint. Runs entirely in your browser.",
      },
      { property: "og:title", content: "Paint by Numbers Maker" },
      {
        property: "og:description",
        content:
          "Turn any photo into a printable paint-by-numbers outline with a custom colour count.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Result = {
  width: number;
  height: number;
  palette: [number, number, number][];
  regions: PbnRegion[];
  previewUrl: string;
  outlineUrl: string;
};

const SIZES = [
  { label: "Small", value: 700 },
  { label: "Medium", value: 1100 },
  { label: "Large", value: 1600 },
];

function hex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function Index() {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("artwork");
  const [colors, setColors] = useState(12);
  const [detail, setDetail] = useState(55);
  const [maxSize, setMaxSize] = useState(1100);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const generate = useCallback(
    async (url: string, numColors: number, detailLevel: number, cap: number) => {
      setBusy(true);
      setError(null);
      setProgress(3);
      setStage("Loading image");

      try {
        const img = new Image();
        img.src = url;
        await img.decode();

        const scale = Math.min(1, cap / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));

        const source = document.createElement("canvas");
        source.width = w;
        source.height = h;
        const sctx = source.getContext("2d");
        if (!sctx) throw new Error("Canvas is not available in this browser");
        sctx.drawImage(img, 0, 0, w, h);
        const imageData = sctx.getImageData(0, 0, w, h);

        workerRef.current?.terminate();
        const worker = new Worker(new URL("../workers/pbn.worker.ts", import.meta.url), {
          type: "module",
        });
        workerRef.current = worker;

        const finished = new Promise<Result>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<PbnMessage>) => {
            const msg = event.data;
            if (msg.type === "progress") {
              setProgress(msg.value);
              setStage(msg.label);
              return;
            }
            if (msg.type === "error") {
              reject(new Error(msg.message));
              return;
            }

            // preview canvas
            const previewCanvas = document.createElement("canvas");
            previewCanvas.width = msg.width;
            previewCanvas.height = msg.height;
            const pctx = previewCanvas.getContext("2d")!;
            pctx.putImageData(
              new ImageData(new Uint8ClampedArray(msg.preview), msg.width, msg.height),
              0,
              0,
            );

            // outline canvas
            const outline = document.createElement("canvas");
            outline.width = msg.width;
            outline.height = msg.height;
            const octx = outline.getContext("2d")!;
            octx.fillStyle = "#ffffff";
            octx.fillRect(0, 0, msg.width, msg.height);

            const edges = new Uint8Array(msg.edges);
            const lineData = octx.getImageData(0, 0, msg.width, msg.height);
            for (let i = 0; i < edges.length; i++) {
              if (edges[i] === 1) {
                lineData.data[i * 4] = 30;
                lineData.data[i * 4 + 1] = 26;
                lineData.data[i * 4 + 2] = 24;
                lineData.data[i * 4 + 3] = 255;
              }
            }
            octx.putImageData(lineData, 0, 0);

            octx.fillStyle = "#1e1a18";
            octx.textAlign = "center";
            octx.textBaseline = "middle";
            for (const region of msg.regions) {
              const size = Math.max(8, Math.min(26, region.r * 1.1));
              if (size < 8) continue;
              octx.font = `600 ${size}px "Work Sans", system-ui, sans-serif`;
              octx.fillText(String(region.color + 1), region.x, region.y);
            }

            resolve({
              width: msg.width,
              height: msg.height,
              palette: msg.palette,
              regions: msg.regions,
              previewUrl: previewCanvas.toDataURL("image/png"),
              outlineUrl: outline.toDataURL("image/png"),
            });
          };
          worker.onerror = () => reject(new Error("Processing failed"));
        });

        const request: PbnRequest = {
          width: w,
          height: h,
          pixels: imageData.data.buffer as ArrayBuffer,
          colors: numColors,
          detail: detailLevel,
        };
        worker.postMessage(request, [request.pixels]);

        const done = await finished;
        setResult(done);
        setProgress(100);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setBusy(false);
        setStage("");
      }
    },
    [],
  );

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        setError("That file isn't an image. Try a JPG or PNG.");
        return;
      }
      const url = URL.createObjectURL(file);
      setFileName(file.name.replace(/\.[^.]+$/, "") || "artwork");
      setFileUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
      setResult(null);
      void generate(url, colors, detail, maxSize);
    },
    [colors, detail, maxSize, generate],
  );

  const download = (url: string, suffix: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName}-${suffix}.png`;
    a.click();
  };

  return (
    <main className="min-h-screen">
      <header className="border-b border-border/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-5 py-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
              Paint kit workshop
            </p>
            <h1 className="mt-2 text-4xl font-black leading-none tracking-tight sm:text-5xl">
              Paint by Numbers Maker
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Upload a photo, choose how many paint colours you want, and get a numbered outline
              with a matching colour key. Everything happens on your device — nothing is uploaded.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Works offline in your browser
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 lg:grid-cols-[320px_1fr]">
        {/* Controls */}
        <aside className="space-y-6">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
            className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
              dragging ? "border-primary bg-primary/5" : "border-border bg-card"
            }`}
          >
            <ImagePlus className="mx-auto h-7 w-7 text-primary" />
            <p className="mt-3 text-sm font-medium">Drop a photo here</p>
            <p className="mt-1 text-xs text-muted-foreground">JPG or PNG, any size</p>
            <Button className="mt-4 w-full" onClick={() => inputRef.current?.click()}>
              Choose an image
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />
          </div>

          <div className="space-y-6 rounded-xl border border-border bg-card p-5">
            <div>
              <div className="flex items-baseline justify-between">
                <Label className="text-sm font-semibold">Number of colours</Label>
                <span className="font-display text-2xl font-bold text-primary">{colors}</span>
              </div>
              <Slider
                className="mt-3"
                min={4}
                max={30}
                step={1}
                value={[colors]}
                onValueChange={(v) => setColors(v[0]!)}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Fewer colours are easier to paint; more colours keep detail.
              </p>
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <Label className="text-sm font-semibold">Detail level</Label>
                <span className="text-sm text-muted-foreground">{detail}</span>
              </div>
              <Slider
                className="mt-3"
                min={0}
                max={100}
                step={5}
                value={[detail]}
                onValueChange={(v) => setDetail(v[0]!)}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Lower settings smooth away small speckles.
              </p>
            </div>

            <div>
              <Label className="text-sm font-semibold">Output size</Label>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {SIZES.map((size) => (
                  <Button
                    key={size.value}
                    type="button"
                    variant={maxSize === size.value ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMaxSize(size.value)}
                  >
                    {size.label}
                  </Button>
                ))}
              </div>
            </div>

            <Button
              className="w-full"
              disabled={!fileUrl || busy}
              onClick={() => fileUrl && generate(fileUrl, colors, detail, maxSize)}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {busy ? "Working…" : "Regenerate"}
            </Button>
          </div>
        </aside>

        {/* Workspace */}
        <section className="space-y-6">
          {error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          )}

          {busy && (
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between text-sm font-medium">
                <span>{stage || "Working"}</span>
                <span className="text-muted-foreground">{Math.round(progress)}%</span>
              </div>
              <Progress className="mt-3" value={progress} />
            </div>
          )}

          {!fileUrl && !busy && (
            <div className="rounded-xl border border-border bg-card p-12 text-center">
              <h2 className="font-display text-2xl font-bold">Your kit will appear here</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                Pick a photo with clear shapes and good light — portraits, pets and landscapes all
                work well.
              </p>
            </div>
          )}

          {result && (
            <>
              <div className="grid gap-6 md:grid-cols-2">
                <figure className="overflow-hidden rounded-xl border border-border bg-card">
                  <img
                    src={result.previewUrl}
                    alt="Simplified colour preview of the uploaded photo"
                    className="w-full"
                  />
                  <figcaption className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
                    <span className="text-sm font-semibold">Colour preview</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => download(result.previewUrl, "preview")}
                    >
                      <Download className="h-4 w-4" /> PNG
                    </Button>
                  </figcaption>
                </figure>

                <figure className="overflow-hidden rounded-xl border border-border bg-card">
                  <img
                    src={result.outlineUrl}
                    alt="Numbered paint by numbers outline generated from the photo"
                    className="w-full"
                  />
                  <figcaption className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
                    <span className="text-sm font-semibold">Numbered outline</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => download(result.outlineUrl, "outline")}
                    >
                      <Download className="h-4 w-4" /> PNG
                    </Button>
                  </figcaption>
                </figure>
              </div>

              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="font-display text-xl font-bold">Colour key</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Mix or buy these {result.palette.length} colours and match them to the numbers.
                </p>
                <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {result.palette.map((color, i) => (
                    <li
                      key={`${hex(color)}-${i}`}
                      className="flex items-center gap-3 rounded-lg border border-border p-2"
                    >
                      <span
                        className="h-9 w-9 shrink-0 rounded-md border border-border"
                        style={{ backgroundColor: hex(color) }}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{i + 1}</span>
                        <span className="block truncate text-xs uppercase text-muted-foreground">
                          {hex(color)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </section>
      </div>

      <footer className="border-t border-border/70 py-8 text-center text-xs text-muted-foreground">
        Your photos never leave this device.
      </footer>
    </main>
  );
}
