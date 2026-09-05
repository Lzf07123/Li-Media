import {
  CircleAlert,
  ExternalLink,
  FolderOpen,
  KeyRound,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { brand } from "@/lib/brand";
import { formatDateTime } from "@/lib/format";

type BaiduSetupCardProps = {
  configured: boolean;
  authorized: boolean;
  docsUrl: string;
  isAuthorizing: boolean;
  oauthConfigured: boolean;
  onAuthorize: () => void;
  redirectUri: string;
  scanDir: string;
  tokenExpiresAt: string | null;
};

export default function BaiduSetupCard({
  configured,
  authorized,
  docsUrl,
  isAuthorizing,
  oauthConfigured,
  onAuthorize,
  redirectUri,
  scanDir,
  tokenExpiresAt,
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
        <Badge tone={authorized ? "success" : configured ? "warning" : "muted"}>
          {authorized
            ? brand.copy.adminRemoteAuthorized
            : configured
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
        <div className="grid min-w-0 gap-2">
          <p className="min-w-0 text-sm">
            <span className="text-muted">{brand.copy.adminRemoteScanDirLabel}: </span>
            <code className="break-all">{scanDir}</code>
          </p>
          <p className="min-w-0 text-sm">
            <span className="text-muted">{brand.copy.adminRemoteRedirectLabel}: </span>
            <code className="break-all">{redirectUri}</code>
          </p>
          <p className="min-w-0 text-sm">
            <span className="text-muted">{brand.copy.adminRemoteTokenExpiry}: </span>
            {tokenExpiresAt
              ? formatDateTime(tokenExpiresAt)
              : brand.copy.adminRemoteNeverExpires}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={isAuthorizing}
            onClick={onAuthorize}
            variant={authorized ? "secondary" : "primary"}
          >
            <ShieldCheck aria-hidden="true" className="size-4" />
            {isAuthorizing
              ? brand.copy.adminRemoteAuthorizing
              : brand.copy.adminRemoteAuthorize}
          </Button>
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
      </div>

      {!configured ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {brand.copy.adminRemoteCredentialHint}
        </p>
      ) : null}
      {!oauthConfigured && configured ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {brand.copy.adminRemoteOauthMissing}
        </p>
      ) : null}
    </aside>
  );
}
