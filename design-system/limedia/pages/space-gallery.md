# Li&Media 空间画廊 · 时间回廊设计方案

> 版本：V1.1 ｜ 日期：2026-11-14 ｜ 状态：**已实现（P0–P2 全量落地）**。实现快照回写见 `../MASTER.md`（V1.6）。
> 相关：[BRAND.md](../BRAND.md) · [MASTER.md](../MASTER.md) · `frontend/src/index.css` · `frontend/src/lib/brand.ts`
> 决策记录：空间形态=时间回廊；技术路线=纯 CSS 3D 零依赖；入口=首页 `?view=space` 视图切换（用户已确认，2026-11-14）。
>
> **V1.2 手感与构图调优**（2026-11-14，回应线上反馈「不够丝滑、留空太多」）：
> - 相机每帧**直写**走廊 transform 与窗口内元素 opacity（原自定义属性写法会触发整棵子树样式重算）；flat 降级以 `!important` 覆盖内联值
> - 运动学更跟手：刚度 0.085→0.12、阻尼 0.82→0.85、滚轮增益 2.4→3.0、限速 90→130 px/帧、闲置吸附 400→300ms
> - 构图减留白：瓦片放大（宽 ≤460→540、高 ≤560→680）、双壁收拢（≤420→380px）、档距收紧（520→460px）；窄屏同步放大（74vw 中带）
> - 顿挫消解（探针实测主线程零丢帧，卡顿感来自运动学）：闲置吸附分级——滑行距离 >0.35 档时切换慢弹簧（0.045/0.9）优雅归位；480 升档延后落定 120ms 错峰解码；pane 增加 hover/聚焦提亮与轻缩放的可点反馈
>
> **V1.1 实现偏差记录**（以代码为准）：
> - pane 背板为透明，`contain` 的 letterbox 融入回廊深底，图像矩形自带 10px 圆角——「无边框纯图瓦」在 3D 下的落地形态；加载占位（表面色面板）独立提供未就绪可见性。
> - flat 时间线不再用固定框：按 `--pane-aspect`（组件由 `width/height` 写入）自适应高度、封面 `cover` 满瓦，无 letterbox 空带。
> - `End` 键语义 = 相机去「已载末尾」；落定触发续载后，再按 `End` 才到最旧端（分页单向推进的自然结果）。
> - 查看器位置口径：空间视图下 total 用回廊全量数据（`getMemories` 响应 `total`），与 HUD「第 n / 总数」一致。
> - 网格工具条的「空间画廊」切换钮窄屏收纯图标（文字 `hidden sm:inline`）且筛选行允许换行——修复新增按钮造成的窄视口横向溢出回归。
> - HUD 含类型筛选三键（≤768px 隐藏）；视频徽章直接复用 `.waterfall-badge`。
> - 吸附前导量 = `gap × 0.42`（由 CSS 令牌推导，非独立常量）。

---

## 1. 定位与设计立场

「安静的档案管理员」进入三维：**回廊即档案馆的走廊，摄影机是访客的脚步**。照片仍是唯一色彩来源——空间本身只有近黑底、雾化与衬线年份里程碑，没有任何新增装饰色。

- **叙事**：进入回廊时站在「今天」（最新一张），向前走 = 向过去回望。推进方向即回忆方向。
- **克制**：无自动旋转、无粒子尘埃、无科技网格（V1.5 氛围层已收敛，禁止回潮）。动效只服务「距离感」一件事。
- **可退**：3D 是渐进增强，不是门票。`prefers-reduced-motion` 与不支持 `preserve-3d` 的环境退化为同构纵向时间线，内容一个不少。

## 2. 信息架构与 URL 状态机

沿用项目现有 URL 驱动模式（`?kind=`、`?viewer=` 已是查询参数），新增一个视图维度：

| URL | 状态 |
| --- | --- |
| `/?view=space` | 时间回廊（默认从最新端开始） |
| `/?view=space&kind=photo` | 回廊 · 仅照片 |
| `/?view=space&viewer=<id>` | 回廊内打开查看器（复用 `MediaViewer`，覆盖层不卸载舞台，相机位置天然保留） |
| `/` | 现有瀑布流（**完全不变**） |

- 切换钮：位于画布筛选条（kind chips 同排）右端，「空间画廊 / 返回网格」双态切换，lucide 图标 + 文字，44px 热区。空间视图下操作栏贴底（含返回网格、上一张/下一张），预留 `safe-area-inset-bottom`。
- 导航三项文案不动，`brand.ts nav` 不新增项。
- 换一批（random seed）在空间视图隐藏——时间轴语义下随机无意义；kind 筛选沿用。
- 滚动恢复：进入回廊前保存网格滚动位置（复用 `limedia:home-scroll` 存储键口径），返回网格时恢复。
- hero 精选舞台在空间视图退场（回廊即舞台）；页眉压图浅色配色复用 `.has-hero` + `data-on-hero` 机制，由空间舞台驱动。

## 3. 空间构成（几何规格）

```
正视图（站在最新端向过去看）

 ┌───────────────────── 页眉（透明压图）─────────────────────┐
 │   [左壁]                    [净空]                  [右壁]  │
 │   ▢ 旧       ▢ 旧      · 当前焦点 ·       ▢ 新   ▢ 新      │
 │      ↖ rotateY 18°        z=-1100px      rotateY -18° ↗   │
 │                                                          │
 │ ──────────── 远端雾化渐隐（bg 同源 scrim）────────────────  │
 │ [返回网格]  2024 年 · 第 12 / 86 张      [上一张] [下一张]  │
 └──────────────────────────────────────────────────────────┘
```

| 项目 | 规格 | 说明 |
| --- | --- | --- |
| 舞台 | `height: 100svh` 全出血（`@supports not` 回退 100vh），`overflow: hidden` | 与移动端 hero 全屏化语言一致 |
| 透视 | `perspective: 1100px`，`perspective-origin: 50% 42%` | 视线略高于地平线的档案室俯仰感 |
| 走廊 | `.space-corridor`，`transform-style: preserve-3d`，唯一持 `will-change: transform` | 相机推进 = 根节点 `translateZ` 单变量，panes 不动 |
| 相片间距 | `--limedia-space-pane-gap: 460px`（Z 轴） | V1.2 收紧档距；焦点 pane 落在 z≈-190px（snapLead = gap×0.42） |
| 双壁 | 左右偏移 `--limedia-space-wall-offset: clamp(200px, 34vw, 380px)`，`rotateY(∓18deg)` 朝内 | V1.2 收拢双壁减中央留白；移动端退化中带单列 |
| 相片瓦 | 无边框纯图瓦（与 `MemoryCard` 语言一致），基准宽 `clamp(340px, 38vw, 540px)`，高 `clamp(340px, 62svh, 680px)`，内部 `contain` | V1.2 放大瓦片填充竖向留白；档案馆不裁历史——竖图 letterbox 融入近黑底 |
| 视频瓦 | 不自动播放：静止缩略 + 右下角时长徽章（复用 hero 元数据语言） | 播放只发生在 `MediaViewer` 内 |
| 雾化 | 每帧仅对窗口内 panes 按 `opacity = clamp(1 - (档距-1.5)/3.5, 0.06, 1)` 写值 | CSS 无逐像素雾，用逐 pane 距离透明度近似；远端 pane 由透视自然缩小 |
| 远端 scrim | 舞台上下各一层 bg 同源线性渐变（无新色令牌） | 隔离页眉与操作栏文字，保 AA |
| 年份里程碑 | `--font-display` 衬线大字 `clamp(2rem, 5vw, 3.5rem)`，贴左壁 `rotateY`，muted 色，随距离淡出 | 里程牌语义：相机每跨一年出现；不做 sticky（flat 模式才做分组头） |

## 4. 交互模型

| 输入 | 行为 |
| --- | --- |
| 滚轮 | `deltaY → targetZ` 累积，临界阻尼 spring 插值；`passive` 监听 + rAF 合帧 |
| 拖拽（桌面/触屏统一 Pointer Events） | 起势阈值 6px 才 `setPointerCapture`（沿用 ecc240b 的「捕获推迟到跟手起势」经验）；纵向拖拽 = 前进/后退 |
| 松手 | 无输入 300ms 后 spring 吸附最近 pane 中心（对齐即「翻到那一页」） |
| 键盘 | `↑/↓` 前进后退一档；`PageUp/PageDown` 三档；`Home/End` 首尾；`Enter` 打开焦点 pane 的查看器；`Tab` 在窗口内 roving tabindex，焦点 pane 时相机 spring 到位（focus-not-obscured） |
| 触屏 | 纵向 swipe 同拖拽 + 惯性吸附；`touch-action: pan-y` + `overscroll-behavior: contain`（舞台固定高、页面无滚动，不与系统手势冲突） |
| 点击 pane | `history.push ?viewer=<id>`——URL 驱动查看器原样复用，返回即回廊且相机不丢 |
| 拖拽替代 | 操作栏「上一张/下一张」常驻按钮（dragging-alternative），≥44px |
| 位置播报 | `aria-live="polite"`：`{year} 年 · 第 {index} / {total} 张`，只报变化不抢焦点 |

无自动轮播 → 天然满足 auto-rotation-controls（不需要暂停键，因为没有自动运动）。

## 5. 动效规范

全部复用既有令牌，不新增时长/缓动体系：

| 场景 | 令牌 | 说明 |
| --- | --- | --- |
| 相机推进 spring | `--limedia-ease-spring` 语感的 JS 临界阻尼（rAF 内实现） | 只写 `transform`，打断即接管（interruptible：新输入立即覆盖 target） |
| 近景 480px 升档换源 | `--limedia-motion-base` 350ms 交叉淡入 | 复用 `.media-crossfade` 语言 |
| 新 pane 入场 | `--limedia-motion-base` + `.media-reveal` 语义 | opacity + translateY，不缩放整墙 |
| 年份里程碑渐显 | `--limedia-motion-slow` 350ms | 随档距透明度变化 |
| 视差（P2，可选） | 指针横向 ±2% `perspective-origin` 摆动，松手回弹 | `@media (prefers-reduced-motion: no-preference)` 门控 |

铁律沿用：只动 `transform/opacity`；每个 animation 有对应 `@keyframes`（如新增）；全局 `prefers-reduced-motion: reduce` 已有降级分支，回廊在其上再叠 flat 模式（见 §7）。

## 6. 图像与加载策略

- **档位**：窗口内远端 panes 固定 240px；距焦点 ≤2 档自动升 480px 档，交叉淡入换源。复用 `resolveThumbnailUrl(id, 240|480)` 与 `image-load-queue` 并发队列（退避重试沿用）。
- **窗口化**：硬窗口 = 相机 ±3 档（7 pane 呈现），挂载上限 12（含缓冲）。离开窗口即卸载 DOM——CSS 3D 路线免 GPU 显存管理，图片随 DOM 移除由浏览器回收（对比 three.js 必须 dispose 的 Critical 项，这是本路线的核心优势）。
- **零 CLS**：舞台固定高、panes 绝对定位，占位即最终几何；pane 尺寸由 `memory.width/height` 实时计算（与 `MediaSkeleton` 同构）。
- **排序与分页**：`getMemories({ kind, sort: "captured_desc" })`——起点第一页即最新端，向前推进 = 列表顺序，单向无限加载：相机接近最旧一端时拉下一页（复用现有 sentinel 口径）。年份由 `captured_at` 客户端分组。
- 空库 / 预热未就绪：回廊退场，渲染 `EmptyState`（复用「还没有公开的回忆内容」口径）；单张内容时隐藏推进 hint。

## 7. 无障碍与降级矩阵

| 条件 | 行为 |
| --- | --- |
| `prefers-reduced-motion: reduce` | **flat 模式**：`perspective: none`，走廊展开为纵向时间线（年份里程碑变 sticky 分组头，pane 保序同 DOM）；滚轮/拖拽失效，普通滚动流接管；无 spring 吸附 |
| 不支持 `preserve-3d` / `perspective` | 同 flat 模式（`@supports not` 检测） |
| 屏幕阅读器 | 舞台 `role="region"` + `aria-label`（brand 键「时间回廊」）；每个 pane 是真实 `<button>`，`aria-label = 标题 · 日期 · 地点`；位置 live region 播报 |
| 键盘 | 全流程可达：Tab 遍历窗口内 panes → Enter 进查看器；焦点环 `--limedia-ring` 2–4px；`Esc` 焦点回操作栏；操作栏不遮焦点 pane（focus-not-obscured） |
| 触控 | pane 触达远超 44px；操作栏按钮 ≥44px 且间距 ≥8px；拖拽有键盘/按钮替代 |
| 对比度 | overlay 文字压 bg 同源 scrim 达 AA；里程碑 muted 色仅装饰语义，信息在 live region 有等价文本 |
| 375px | 单列中带，pane 宽 78vw；操作栏收进安全区；无横向溢出 |

## 8. 性能预算

- 单 rAF 循环：每帧只写 corridor 根 `translateZ` + 窗口内 panes 的 `opacity`；无循环内布局读（pane 几何在 mount 时缓存）。
- `will-change: transform` 只给 corridor 根，panes 不加（防合成层爆炸）。
- 舞台离屏或 `document.hidden` 时停 rAF（IntersectionObserver + visibilitychange）。
- 输入延迟目标 <100ms：wheel/pointermove passive + rAF 合帧，不在事件回调里做任何渲染。
- 挂载 ≤12 pane + 240px 档起步：首帧进入空间视图的解码压力与一屏瀑布流相当。
- 不引入任何新依赖；新增 CSS 避免出现 `rgba(` 字面量（颜色一律走语义令牌，通过仓库硬编码扫描脚本）。

## 9. 令牌与文案增量

**`frontend/src/index.css` 新增（仅几何量，零新色）：**

```css
--limedia-space-perspective: 1100px;
--limedia-space-pane-gap: 460px;
--limedia-space-wall-offset: clamp(200px, 34vw, 380px);
--limedia-space-wall-angle: 18deg;
--limedia-space-pane-w: clamp(340px, 38vw, 540px);
--limedia-space-pane-h: clamp(340px, 62svh, 680px);
```

雾化曲线（`FOG_NEAR 1.5 / FOG_FAR 5 / FOG_MIN 0.06`，档距单位）是相机算法参数，与运动学常量一起落在 `use-space-camera.ts`，不进 CSS 令牌。

**`frontend/src/lib/brand.ts` 新增 `space` 段（导航不动）：**

```ts
space: {
  toggle: "空间画廊",
  toggleActive: "返回网格",
  stageLabel: "时间回廊",
  hint: "滚动或拖拽，沿时间回望",
  position: "{year} 年 · 第 {index} / {total} 张",
  prev: "上一张",
  next: "下一张",
  empty: "还没有可以漫步的回忆。",
},
```

## 10. 组件与文件落点

| 文件 | 职责 |
| --- | --- |
| `frontend/src/components/space/SpaceGallery.tsx` | 舞台 + 走廊 + 操作栏；`React.lazy` 加载（同 `MediaViewer` 惯例） |
| `frontend/src/components/space/SpacePane.tsx` | 单 pane（memo 化，按 `memory.width/height` 算几何，双档图源交叉淡入） |
| `frontend/src/components/space/use-space-camera.ts` | rAF spring 相机状态机 + 输入绑定（wheel/pointer/keyboard 三入口解耦） |
| `frontend/src/pages/HomePage.tsx` | 读 `view` 参数、条件渲染、切换钮；网格分支不动 |
| `frontend/src/index.css` | `@layer components` 内 `.space-*` 类；响应式覆盖放层外（沿用 MASTER 口径） |
| `frontend/src/lib/brand.ts` | `space` 文案段 |

不改动：`App.tsx` 路由、`MediaViewer`、`HeroFeature`、后端（`sort=captured_desc` 已支持）。

## 11. 分期实施

| 期 | 内容 | 出口标准 |
| --- | --- | --- |
| **P0 回廊骨架** | 切换钮 + `?view=space` + 走廊几何 + 滚轮/键盘推进 + 雾化 + 年份里程碑 + 点击进查看器 + flat 降级 | 375/768/1024/1440 无横向溢出；reduced-motion 全流程可用；typecheck/build 过 |
| **P1 手感** | 拖拽/触摸 + 惯性吸附 + 480 升档 + 焦点跟随 + 底部操作栏 + 位置播报 | 键盘全流程；拖拽有替代；升档无闪烁 |
| **P2 氛围** | 指针视差（no-preference 门控）+ 里程碑渐显打磨 + 与 AmbientBackground 颗粒层统一 | 主线程预算达标；动画每视图 ≤2 关键元素 |

## 12. 验收清单

- [ ] `npm run typecheck`、`npm run build`、后端 `pytest` 通过
- [ ] 仓库硬编码颜色扫描脚本通过（新增 CSS 无 `rgba(` 字面量）
- [ ] 375 / 768 / 1024 / 1440 四档无横向溢出，移动端预留底部安全区
- [ ] `prefers-reduced-motion` 下 flat 时间线完整可用
- [ ] 纯键盘走通：进入 → 遍历 → 进查看器 → 返回相机不丢
- [ ] overlay 文字 AA 对比；焦点环可见且不被操作栏遮挡
- [ ] 视频瓦不自动播放；空库/预热态退场干净
- [ ] `?view=space&viewer=id` 深链直达；返回网格滚动位置恢复
- [ ] 快速连滚/连拖时动画可打断，最终状态正确（cancellable-state-transitions）

## 13. 明确不做

- 不用 three.js / WebGL（本轮决策；若未来需要真实雾/光照再评估，但须重新过性能与无障碍预算）
- 不做地面网格、粒子、反射（V1.5 氛围收敛铁律）
- 不做视频 pane 自动播放与画中画
- 不新增导航项、不新增颜色令牌、不改 hero 与瀑布流的任何既有行为
