import type { MemorySummary } from "@/lib/api";

// 画布构图缓存：把最近一次真实列表的图像宽高序列持久化到
// localStorage，供下次加载/刷新时骨架屏按真实宽高实时计算占位形状——
// 骨架与真实布局同构、零位移，避免「一整块均色」式占位。
// 缓存过期无害：骨架只是占位形状，真实数据一到即被替换。

export type CompositionSize = {
  width: number;
  height: number;
};

export type CanvasComposition = {
  /** 首屏精选（画布第一条）的宽高，供 hero 骨架内嵌同比例占位框 */
  hero: CompositionSize | null;
  items: CompositionSize[];
};

const STORAGE_KEY = "limedia-canvas-composition";
const MAX_ITEMS = 36;

function isCompositionSize(value: unknown): value is CompositionSize {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CompositionSize>;
  return (
    typeof candidate.width === "number"
    && Number.isFinite(candidate.width)
    && candidate.width > 0
    && typeof candidate.height === "number"
    && Number.isFinite(candidate.height)
    && candidate.height > 0
  );
}

function toSize(memory: MemorySummary): CompositionSize | null {
  if (!memory.width || !memory.height) {
    return null;
  }
  return { width: memory.width, height: memory.height };
}

export function readCanvasComposition(): CanvasComposition {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { hero: null, items: [] };
    }
    const parsed = JSON.parse(raw) as CanvasComposition;
    if (!parsed || !Array.isArray(parsed.items)) {
      return { hero: null, items: [] };
    }
    return {
      hero: isCompositionSize(parsed.hero) ? parsed.hero : null,
      items: parsed.items.filter(isCompositionSize).slice(0, MAX_ITEMS),
    };
  } catch {
    // 隐私模式 / 存储被禁用 / 数据损坏：骨架回退多样比例兜底
    return { hero: null, items: [] };
  }
}

/** 列表数据到达后写入构图缓存（hero 取第一条，与首屏捕获同源） */
export function writeCanvasComposition(memories: MemorySummary[]): void {
  const sizes = memories
    .slice(0, MAX_ITEMS)
    .map(toSize)
    .filter((size): size is CompositionSize => size !== null);
  if (sizes.length === 0) {
    return;
  }

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ hero: sizes[0], items: sizes } satisfies CanvasComposition),
    );
  } catch {
    // 存储不可用时静默放弃，不影响正常渲染
  }
}
