import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <div className="rounded-lg border border-border bg-surface p-6 text-center">
      <h1 className="text-xl font-semibold">页面不存在</h1>
      <p className="mt-2 text-sm text-muted">请检查地址，或回到媒体库首页。</p>
      <Link className="mt-4 inline-flex min-h-11 items-center text-primary" to="/">
        返回首页
      </Link>
    </div>
  );
}

