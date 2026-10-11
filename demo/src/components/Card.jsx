/**
 * 演示用组件（JSX 形状的源码，由 demo/assets/app.js 取来渲染）。
 *
 * 这个文件**是插件的写回目标**：在演示站点上选中这张卡片、改颜色或尺寸，
 * 改动就会落到下面这些属性的位置——你可以打开文件看值有没有变。
 */

export function Card() {
  return (
    <article className="card demo-card" data-from="Card.jsx">
      <h3 className="card-title">来自组件文件的卡片</h3>
      <p className="card-desc">这张卡片的标题与描述都在 src/components/Card.jsx 里。</p>
      <p className="card-price">¥ 自由定价</p>
    </article>
  );
}
