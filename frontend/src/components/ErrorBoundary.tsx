import { Component, type ErrorInfo, type ReactNode } from "react";

import { brand } from "@/lib/brand";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

/**
 * 根级兜底边界：渲染异常或懒加载 chunk 失效时给出可恢复入口，
 * 而不是整站白屏。重载后会重新拉取最新 index.html 与 chunk。
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground"
          role="alert"
        >
          <p className="text-sm text-muted">{brand.copy.appErrorMessage}</p>
          <button
            className="min-h-11 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => window.location.reload()}
            type="button"
          >
            {brand.copy.appErrorReload}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
