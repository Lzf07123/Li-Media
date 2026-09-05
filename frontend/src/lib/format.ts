import { brand } from "@/lib/brand";

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) {
    return null;
  }

  if (bytes < 1024) {
    return `${bytes} ${brand.copy.bytes}`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) {
    return null;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const twoDigits = (value: number) => String(value).padStart(2, "0");

  return hours > 0
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(remainingSeconds)}`
    : `${minutes}:${twoDigits(remainingSeconds)}`;
}

export function formatDateTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
