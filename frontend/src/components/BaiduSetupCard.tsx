import {
  CircleAlert,
  ExternalLink,
  FolderOpen,
  KeyRound,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import Badge from "@/components/ui/Badge";
import { brand } from "@/lib/brand";

type BaiduSetupCardProps = {
  configured: boolean;
  docsUrl: string;
  scanDir: string;
};

export default function BaiduSetupCard({
  configured,
  docsUrl,
  scanDir,
}: BaiduSetupCardProps) {
  const steps = [
    {
      icon: ShieldCheck,
      text: brand.copy.adminRemoteGuideCreateApp,
    },
    {
      icon: KeyRound,
      text: brand.copy.adminRemoteGuideToken,
    },
    {
      icon: FolderOpen,
      text: brand.copy.adminRemoteGuideDirectory,
    },
    {
      icon: RefreshCw,
      text: brand.copy.adminRemoteGuideScan,
    },
  ];

  return (
    <aside aria-labelledby="baidu-setup-title" className="card mt-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold" id="baidu-setup-title">
            {brand.copy.adminRemoteGuideTitle}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {brand.copy.adminRemoteGuideDescription}
          </p>
        </div>
        <Badge tone={configured ? "success" : "warning"}>
          {configured
            ? brand.copy.adminRemoteCredentialConfigured
            : brand.copy.adminRemoteCredentialMissing}
        </Badge>
      </div>

      <ol className="mt-5 grid gap-3">
        {steps.map(({ icon: Icon, text }, index) => (
          <li className="flex items-start gap-3" key={text}>
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-primary"
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 text-sm leading-6">
              <span className="sr-only">{index + 1}. </span>
              {text}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm">
          <span className="text-muted">{brand.copy.adminRemoteScanDirLabel}: </span>
          <code className="break-all">{scanDir}</code>
        </p>
        <a
          className="inline-flex min-h-11 items-center gap-2 text-primary"
          href={docsUrl}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink aria-hidden="true" className="size-4" />
          {brand.copy.adminRemoteGuideDocs}
        </a>
      </div>

      {!configured ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {brand.copy.adminRemoteCredentialHint}
        </p>
      ) : null}
    </aside>
  );
}
