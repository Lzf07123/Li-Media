import { useState } from "react";
import { Images } from "lucide-react";

import Button from "@/components/ui/Button";
import ProgressBar from "@/components/ui/ProgressBar";
import { Input } from "@/components/ui/Input";
import { brand } from "@/lib/brand";
import type { ThumbnailPreheatJob } from "@/lib/api";

type ThumbnailPreheatCardProps = {
  job: ThumbnailPreheatJob | null;
  isStarting: boolean;
  onStart: (payload: {
    max_size: "240" | "480" | "768" | "1280";
    kind?: "photo" | "video";
    limit: number;
  }) => Promise<void>;
};

const sizes = ["240", "480", "768", "1280"] as const;
const statusCopy = {
  queued: brand.copy.adminPreheatQueued,
  running: brand.copy.adminPreheatRunning,
  completed: brand.copy.adminPreheatCompleted,
  failed: brand.copy.adminPreheatFailed,
};

export default function ThumbnailPreheatCard({
  job,
  isStarting,
  onStart,
}: ThumbnailPreheatCardProps) {
  const [maxSize, setMaxSize] = useState<(typeof sizes)[number]>("480");
  const [kind, setKind] = useState<"" | "photo" | "video">("");
  const [limit, setLimit] = useState("24");
  const isJobActive = job?.status === "queued" || job?.status === "running";

  return (
    <div className="card mt-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Images aria-hidden="true" className="mt-1 size-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">
              {brand.copy.adminPreheatTitle}
            </h3>
            <p className="mt-1 text-xs text-muted">
              {brand.copy.adminPreheatDescription}
            </p>
          </div>
        </div>
        <Button
          disabled={isStarting || isJobActive}
          onClick={() =>
            void onStart({
              max_size: maxSize,
              kind: kind || undefined,
              limit: Math.min(200, Math.max(1, Number(limit) || 24)),
            })
          }
        >
          {isStarting || isJobActive
            ? brand.copy.adminPreheatStarting
            : brand.copy.adminPreheatStart}
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-2 text-sm" htmlFor="preheat-size">
          {brand.copy.adminPreheatSize}
          <select
            className="select min-h-11"
            id="preheat-size"
            onChange={(event) =>
              setMaxSize(event.target.value as (typeof sizes)[number])
            }
            value={maxSize}
          >
            {sizes.map((size) => (
              <option key={size} value={size}>
                {size}px
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm" htmlFor="preheat-kind">
          {brand.copy.adminPreheatKind}
          <select
            className="select min-h-11"
            id="preheat-kind"
            onChange={(event) =>
              setKind(event.target.value as "" | "photo" | "video")
            }
            value={kind}
          >
            <option value="">{brand.copy.adminPreheatAllKinds}</option>
            <option value="photo">{brand.copy.adminPreheatPhoto}</option>
            <option value="video">{brand.copy.adminPreheatVideo}</option>
          </select>
        </label>

        <Input
          id="preheat-limit"
          label={brand.copy.adminPreheatLimit}
          max={200}
          min={1}
          onChange={(event) => setLimit(event.target.value)}
          type="number"
          value={limit}
        />
      </div>

      {job ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted">
              {brand.copy.adminPreheatStatus}: {statusCopy[job.status]}
            </span>
            <span className="text-xs text-muted">
              {job.processed}/{job.total || job.limit}
            </span>
          </div>
          <ProgressBar
            label={brand.copy.adminPreheatTitle}
            tone={job.status === "failed" ? "danger" : "primary"}
            value={(job.processed / (job.total || job.limit)) * 100}
          />
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatGenerated}</dt>
              <dd className="text-sm font-medium">{job.generated}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatCached}</dt>
              <dd className="text-sm font-medium">{job.cached}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatFailedCount}</dt>
              <dd className="text-sm font-medium">{job.failed}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatSize}</dt>
              <dd className="text-sm font-medium">{job.max_size}px</dd>
            </div>
          </dl>
          {job.message ? (
            <p className="mt-3 break-all text-xs text-muted">{job.message}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
