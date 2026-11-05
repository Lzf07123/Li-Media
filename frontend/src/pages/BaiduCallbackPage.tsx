import { useEffect, useState } from "react";
import { CircleCheck, CircleAlert } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { brand } from "@/lib/brand";
import { completeBaiduAuthorization } from "@/lib/api";
import MediaSkeleton from "@/components/ui/MediaSkeleton";
import Notice from "@/components/ui/Notice";

type CallbackState = "loading" | "success" | "failed";

export default function BaiduCallbackPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<CallbackState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 仅在挂载时读取一次回调参数；处理前先清参，授权码不滞留地址栏与历史。
    const code = searchParams.get("code");
    const oauthState = searchParams.get("state");
    const oauthError = searchParams.get("error");
    let active = true;

    setSearchParams({}, { replace: true });

    if (oauthError || !code || !oauthState) {
      setState("failed");
      // URL error 参数只映射固定文案，不回显外部来源文本。
      setError(brand.copy.adminRemoteCallbackFailed);
      return;
    }

    completeBaiduAuthorization({ code, state: oauthState })
      .then(() => {
        if (active) {
          setState("success");
        }
      })
      .catch((callbackError: unknown) => {
        if (!active) {
          return;
        }
        setState("failed");
        setError(
          callbackError instanceof Error
            ? callbackError.message
            : brand.copy.adminRemoteCallbackFailed,
        );
      });

    return () => {
      active = false;
    };
    // 回调只在进入页面时处理一次；searchParams 清除后无需重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "loading") {
    return <MediaSkeleton count={1} />;
  }

  return (
    <section aria-live="polite" className="mx-auto mt-16 max-w-xl">
      {state === "success" ? (
        <div className="card flex flex-col items-center gap-4 p-8 text-center">
          <CircleCheck aria-hidden="true" className="size-10 text-primary" />
          <h1 className="text-2xl font-semibold">
            {brand.copy.adminRemoteCallbackSuccess}
          </h1>
          <Link className="min-h-11 inline-flex items-center text-primary" to="/admin">
            {brand.copy.adminRemoteCallbackReturn}
          </Link>
        </div>
      ) : (
        <div className="card flex flex-col gap-4 p-8">
          <div className="flex items-center gap-3">
            <CircleAlert aria-hidden="true" className="size-6 text-danger" />
            <h1 className="text-2xl font-semibold">
              {brand.copy.adminRemoteCallbackFailed}
            </h1>
          </div>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Link className="min-h-11 inline-flex items-center text-primary" to="/admin">
            {brand.copy.adminRemoteCallbackReturn}
          </Link>
        </div>
      )}
    </section>
  );
}
