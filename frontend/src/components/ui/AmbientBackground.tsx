// 氛围层（V1.5 暗夜档案馆）：静态胶片颗粒 + 单枚极淡光晕。
// 颗粒与光晕均为无动画静态层，不参与 prefers-reduced-motion 分支；
// 装饰光效（极光/科技网格/光束/光点）已按 BRAND.md V1.1 退场。
export default function AmbientBackground() {
  return (
    <div aria-hidden="true" className="ambient-layer">
      <span className="ambient-halo" />
      <span className="ambient-grain" />
    </div>
  );
}
