import { useCallback, useEffect, useRef, type RefObject } from "react";

/** 回廊几何参数：间距与吸附前导量（px），由 SpaceGallery 从 CSS 令牌读出 */
export type SpaceCameraGeometry = {
  gap: number;
  snapLead: number;
};

export type SpaceCameraOptions = {
  stageRef: RefObject<HTMLElement | null>;
  corridorRef: RefObject<HTMLElement | null>;
  /** 雾化目标注册表：元素 → 世界坐标 Z（px）。窗口外的元素不在表内，
   *  每帧雾化成本 = 窗口大小而非内容总量。 */
  fogTargetsRef: RefObject<Map<HTMLElement, number>>;
  countRef: RefObject<number>;
  geometryRef: RefObject<SpaceCameraGeometry>;
  /** false = flat 降级（reduced-motion / 不支持 3D）：卸载全部输入与 rAF */
  enabled: boolean;
  /** 焦点档位变化（最近档位，行进中即更新） */
  onIndexChange: (index: number) => void;
  /** 相机落定档位；行进/拖拽中为 null（位置播报与 480 升档用它防抖） */
  onSettled: (index: number | null) => void;
};


// —— 相机调参（帧率无关：系数按 dt 归一） ——
/** 滚轮增益：一格 ≈ 半个档位偏多，跟手感优先 */
const WHEEL_FACTOR = 3.0;
/** 拖拽 1px = 相机 1.15px（上拖为前进） */
const DRAG_FACTOR = 1.15;
/** spring 刚度/阻尼：刚度偏高让输入更贴手，阻尼保持临界过冲内 */
const STIFFNESS = 0.12;
const DAMPING = 0.85;
/** 闲置吸附分级：滑行距离超过 0.35 档时改用慢系数优雅归位，
 *  消除「停一下→突然加速」的顿挫感 */
const SNAP_STIFFNESS = 0.045;
const SNAP_DAMPING = 0.9;
const SNAP_SOFT_RATIO = 0.35;
/** 无输入 300ms 后吸附最近档位 */
const IDLE_SNAP_DELAY_MS = 300;
/** 松手惯性投影时长（ms） */
const INERTIA_LOOKAHEAD_MS = 180;
/** 拖拽起势阈值：低于此距离视为轻点，不捕获指针 */
const DRAG_THRESHOLD_PX = 6;
/** 指针视差摆幅上限（deg）；走廊根节点 rotateY */
const MAX_TILT_DEG = 1.2;
/** 雾化曲线：档距 ≤1.5 全清晰，到 5 档衰减至 FOG_MIN */
const FOG_NEAR = 1.5;
const FOG_FAR = 5;
const FOG_MIN = 0.06;
/** 已掠过相片（相机平面之后）的淡出距离 px */
const PASS_FADE_PX = 600;
/** 单帧速度上限 px，长距飞行不拖沓且防惯性甩飞 */
const MAX_VELOCITY = 130;

type DragSample = { time: number; position: number };

type SpaceCameraState = {
  position: number;
  velocity: number;
  target: number;
  tilt: number;
  tiltTarget: number;
  initialized: boolean;
  dragging: boolean;
  dragPointerId: number;
  dragStartY: number;
  dragStartX: number;
  dragDistance: number;
  dragStartPosition: number;
  dragSamples: DragSample[];
  lastInputAt: number;
  lastEmittedIndex: number;
  settledEmitted: boolean;
  frameHandle: number;
  running: boolean;
  lastFrameTime: number;
  lastFogValues: WeakMap<Element, number>;
  hoverCapable: boolean;
  hoverRect: { left: number; width: number } | null;
};

/**
 * 时间回廊相机：单一 rAF 循环驱动的弹簧状态机。
 * 输入（滚轮/指针拖拽/键盘）只改写 target，位置经 spring 追赶；
 * 每帧输出 = 走廊根节点 transform 直写 + 窗口内元素 opacity 直写
 * （直写避免自定义属性引发的子树样式重算）。铁律：只动 transform/opacity。
 */
export function useSpaceCamera({
  stageRef,
  corridorRef,
  fogTargetsRef,
  countRef,
  geometryRef,
  enabled,
  onIndexChange,
  onSettled,
}: SpaceCameraOptions) {
  // 最新回调经 ref 透传，输入绑定与 rAF 循环只需建立一次
  const callbacksRef = useRef({ onIndexChange, onSettled });
  useEffect(() => {
    callbacksRef.current = { onIndexChange, onSettled };
  });

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  });

  const stateRef = useRef<SpaceCameraState>({
    position: 0,
    velocity: 0,
    target: 0,
    tilt: 0,
    tiltTarget: 0,
    initialized: false,
    dragging: false,
    dragPointerId: -1,
    dragStartY: 0,
    dragStartX: 0,
    dragDistance: 0,
    dragStartPosition: 0,
    dragSamples: [],
    lastInputAt: 0,
    lastEmittedIndex: -1,
    settledEmitted: false,
    frameHandle: 0,
    running: false,
    lastFrameTime: 0,
    lastFogValues: new WeakMap(),
    hoverCapable: false,
    hoverRect: null,
  });

  const clampPosition = useCallback(
    (position: number): number => {
      const { gap, snapLead } = geometryRef.current;
      const min = gap - snapLead;
      const max = Math.max(min, countRef.current * gap - snapLead);
      return Math.min(max, Math.max(min, position));
    },
    [geometryRef, countRef],
  );

  const snapOfIndex = useCallback(
    (index: number): number => {
      const { gap, snapLead } = geometryRef.current;
      const count = countRef.current;
      const clamped = Math.min(Math.max(index, 0), Math.max(0, count - 1));
      return (clamped + 1) * gap - snapLead;
    },
    [geometryRef, countRef],
  );

  const indexOfPosition = useCallback(
    (position: number): number => {
      const { gap, snapLead } = geometryRef.current;
      const count = countRef.current;
      if (count <= 0) {
        return 0;
      }
      const raw = Math.round((position + snapLead) / gap) - 1;
      return Math.min(Math.max(raw, 0), count - 1);
    },
    [geometryRef, countRef],
  );

  const goToIndex = useCallback(
    (index: number) => {
      const state = stateRef.current;
      state.target = clampPosition(snapOfIndex(index));
      state.lastInputAt = performance.now();
    },
    [clampPosition, snapOfIndex],
  );

  const stepBy = useCallback(
    (steps: number) => {
      goToIndex(indexOfPosition(stateRef.current.target) + steps);
    },
    [goToIndex, indexOfPosition],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !enabled) {
      return;
    }

    const state = stateRef.current;
    state.hoverCapable =
      window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    const frame = (time: number) => {
      state.frameHandle = 0;
      const { gap } = geometryRef.current;
      const step = Math.min(50, time - (state.lastFrameTime || time)) / 16.667;
      state.lastFrameTime = time;

      if (!state.initialized) {
        // 初始站在「今天」：最新一张已落在焦点档位
        state.target = clampPosition(snapOfIndex(0));
        state.position = state.target;
        state.initialized = true;
      }
      state.target = clampPosition(state.target);

      if (!state.dragging) {
        const idle =
          time - state.lastInputAt > IDLE_SNAP_DELAY_MS &&
          Math.abs(state.velocity) < 0.05;
        if (idle) {
          state.target = snapOfIndex(indexOfPosition(state.target));
        }
        // 吸附分级：闲置归位且滑行距离远时放慢弹簧——顺滑远滑入，
        // 近距与跟手输入保持正常刚度
        const soft =
          idle &&
          Math.abs(state.target - state.position) > gap * SNAP_SOFT_RATIO;
        state.velocity +=
          (state.target - state.position) *
          (soft ? SNAP_STIFFNESS : STIFFNESS) *
          step;
        state.velocity *= Math.pow(soft ? SNAP_DAMPING : DAMPING, step);
        state.velocity = Math.max(
          -MAX_VELOCITY,
          Math.min(MAX_VELOCITY, state.velocity),
        );
        state.position += state.velocity * step;
        if (
          Math.abs(state.target - state.position) < 0.12 &&
          Math.abs(state.velocity) < 0.12
        ) {
          state.position = state.target;
          state.velocity = 0;
        }
      }

      state.tilt +=
        (state.tiltTarget - state.tilt) * Math.min(1, 0.08 * step);

      // 相机 transform 直写：写自定义属性会触发走廊整棵子树的样式重算，
      // 直写 transform 只更新自身合成层——每帧丝滑度的关键路径
      const corridor = corridorRef.current;
      if (corridor) {
        corridor.style.transform = `translateZ(${state.position.toFixed(2)}px) rotateY(${state.tilt.toFixed(3)}deg)`;
      }

      fogTargetsRef.current.forEach((worldZ, element) => {
        const effectiveZ = worldZ + state.position;
        let fog: number;
        if (effectiveZ <= 0) {
          const bays = -effectiveZ / gap;
          fog =
            bays <= FOG_NEAR
              ? 1
              : Math.max(
                  FOG_MIN,
                  1 - (bays - FOG_NEAR) / (FOG_FAR - FOG_NEAR),
                );
        } else {
          fog = Math.max(FOG_MIN, 1 - effectiveZ / PASS_FADE_PX);
        }
        const previous = state.lastFogValues.get(element);
        if (previous === undefined || Math.abs(previous - fog) > 0.02) {
          state.lastFogValues.set(element, fog);
          element.style.opacity = fog.toFixed(3);
        }
      });

      const index = indexOfPosition(state.position);
      if (index !== state.lastEmittedIndex) {
        state.lastEmittedIndex = index;
        callbacksRef.current.onIndexChange(index);
      }
      const settled =
        !state.dragging &&
        state.position === state.target &&
        state.velocity === 0;
      if (settled !== state.settledEmitted) {
        state.settledEmitted = settled;
        callbacksRef.current.onSettled(settled ? index : null);
      }

      if (state.running) {
        state.frameHandle = window.requestAnimationFrame(frame);
      }
    };

    const start = () => {
      if (state.running || !enabledRef.current) {
        return;
      }
      state.running = true;
      state.lastFrameTime = 0;
      state.frameHandle = window.requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!state.running) {
        return;
      }
      state.running = false;
      if (state.frameHandle) {
        window.cancelAnimationFrame(state.frameHandle);
        state.frameHandle = 0;
      }
    };

    // 滚轮 passive 监听、不 preventDefault：沉浸模式页面本身无滚动
    // （页脚隐藏 + page-shell 零底 padding），无需担心链式滚动。
    const onWheel = (event: WheelEvent) => {
      state.target = clampPosition(
        state.target + event.deltaY * WHEEL_FACTOR,
      );
      state.lastInputAt = event.timeStamp;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary) {
        return;
      }
      state.dragPointerId = event.pointerId;
      state.dragStartY = event.clientY;
      state.dragStartX = event.clientX;
      state.dragDistance = 0;
      state.dragStartPosition = state.position;
      state.dragSamples = [{ time: event.timeStamp, position: state.position }];
      state.velocity = 0;
      state.lastInputAt = event.timeStamp;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (state.dragPointerId !== event.pointerId) {
        // 指针视差：仅 hover 设备，横移时整个走廊轻微转向视线
        if (state.hoverCapable && !state.dragging) {
          const rect = state.hoverRect;
          if (rect && rect.width > 0) {
            const normX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            state.tiltTarget = normX * -MAX_TILT_DEG;
          }
        }
        return;
      }
      const distance = Math.hypot(
        event.clientX - state.dragStartX,
        event.clientY - state.dragStartY,
      );
      if (!state.dragging) {
        if (distance < DRAG_THRESHOLD_PX) {
          return;
        }
        state.dragging = true;
        // 捕获推迟到跟手起势（沿用 ecc240b 的修复口径）：轻点不受捕获
        // 影响，起势后 click 被重定向到舞台，pane 误触自然被抑制。
        try {
          stage.setPointerCapture(event.pointerId);
        } catch {
          // 指针可能已失效（如触摸被系统手势接管），拖拽照常进行
        }
      }
      state.dragDistance = distance;
      const dy = state.dragStartY - event.clientY;
      state.position = clampPosition(
        state.dragStartPosition + dy * DRAG_FACTOR,
      );
      state.dragSamples.push({ time: event.timeStamp, position: state.position });
      while (
        state.dragSamples.length > 2 &&
        event.timeStamp - state.dragSamples[0].time > 120
      ) {
        state.dragSamples.shift();
      }
      state.lastInputAt = event.timeStamp;
    };

    const onPointerUpOrCancel = (event: PointerEvent) => {
      if (state.dragPointerId !== event.pointerId) {
        return;
      }
      state.dragPointerId = -1;
      state.tiltTarget = 0;
      if (!state.dragging) {
        return;
      }
      state.dragging = false;
      try {
        stage.releasePointerCapture(event.pointerId);
      } catch {
        // 捕获可能已随 pointercancel 释放
      }
      // 惯性投影 → 吸附最近档位
      const samples = state.dragSamples;
      let velocityPerFrame = 0;
      if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const elapsed = last.time - first.time;
        if (elapsed > 16) {
          velocityPerFrame =
            ((last.position - first.position) / elapsed) * 16.667;
        }
      }
      state.velocity = Math.max(
        -MAX_VELOCITY,
        Math.min(MAX_VELOCITY, velocityPerFrame),
      );
      const projected =
        state.position + state.velocity * (INERTIA_LOOKAHEAD_MS / 16.667);
      state.target = snapOfIndex(indexOfPosition(projected));
      state.lastInputAt = performance.now();
    };

    const onPointerEnter = (event: PointerEvent) => {
      if (!state.hoverCapable || !event.isPrimary) {
        return;
      }
      const rect = stage.getBoundingClientRect();
      state.hoverRect = { left: rect.left, width: rect.width };
    };
    const onPointerLeave = () => {
      state.tiltTarget = 0;
      state.hoverRect = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          goToIndex(indexOfPosition(state.target) + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          goToIndex(indexOfPosition(state.target) - 1);
          break;
        case "PageDown":
          event.preventDefault();
          goToIndex(indexOfPosition(state.target) + 3);
          break;
        case "PageUp":
          event.preventDefault();
          goToIndex(indexOfPosition(state.target) - 3);
          break;
        case "Home":
          event.preventDefault();
          goToIndex(0);
          break;
        case "End":
          event.preventDefault();
          goToIndex(countRef.current - 1);
          break;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        start();
      } else {
        stop();
      }
    };

    stage.addEventListener("wheel", onWheel, { passive: true });
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUpOrCancel);
    stage.addEventListener("pointercancel", onPointerUpOrCancel);
    stage.addEventListener("pointerenter", onPointerEnter);
    stage.addEventListener("pointerleave", onPointerLeave);
    stage.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibilityChange);
    start();

    return () => {
      stop();
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", onPointerUpOrCancel);
      stage.removeEventListener("pointercancel", onPointerUpOrCancel);
      stage.removeEventListener("pointerenter", onPointerEnter);
      stage.removeEventListener("pointerleave", onPointerLeave);
      stage.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    enabled,
    stageRef,
    corridorRef,
    fogTargetsRef,
    geometryRef,
    countRef,
    clampPosition,
    snapOfIndex,
    indexOfPosition,
    goToIndex,
  ]);

  return { goToIndex, stepBy };
}
