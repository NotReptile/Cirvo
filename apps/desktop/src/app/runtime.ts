export type RenderRegion =
  | "all"
  | "channels"
  | "members"
  | "messages"
  | "pins"
  | "voice"
  | "call"
  | "modal"
  | "status";
type Renderer = (regions?: ReadonlySet<RenderRegion>) => void;
let renderer: Renderer | null = null;
let queued = new Set<RenderRegion>();
let pending = false;

export function setRenderer(value: Renderer): void {
  renderer = value;
}
export function requestRender(
  regions: ReadonlySet<RenderRegion> = new Set(["all"]),
): void {
  renderer?.(regions);
}

export function queueRender(...regions: RenderRegion[]): void {
  if (!regions.length) regions = ["all"];
  for (const region of regions) queued.add(region);
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    const regions = [...queued];
    queued = new Set();
    renderer?.(new Set(regions.includes("all") ? ["all"] : regions));
  });
}
