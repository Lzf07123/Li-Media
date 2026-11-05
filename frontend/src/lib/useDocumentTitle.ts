import { useEffect } from "react";

// 路由与查看器内容变化时同步 document.title，保证分享卡片与
// 浏览器历史条目可区分；未调用时保持上一级页面标题。
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
