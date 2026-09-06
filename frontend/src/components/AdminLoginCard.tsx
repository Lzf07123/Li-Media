import type { FormEvent } from "react";

import { brand } from "@/lib/brand";
import Avatar from "@/components/ui/Avatar";
import BlurText from "@/components/ui/BlurText";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import Notice from "@/components/ui/Notice";

type AdminLoginCardProps = {
  error?: string | null;
  token: string;
  onTokenChange: (token: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export default function AdminLoginCard({
  error,
  token,
  onTokenChange,
  onSubmit,
}: AdminLoginCardProps) {
  return (
    <section className="card card-signature card-halo page-enter mx-auto max-w-md p-6 sm:p-8">
      <div className="flex flex-col items-center gap-3">
        <Avatar name={brand.copyrightHolder} size="lg" />
        <BlurText
          as="h1"
          className="text-xl font-semibold"
          text={brand.copy.adminLoginTitle}
        />
      </div>
      <p className="mt-2 text-sm text-muted">{brand.copy.adminLoginDescription}</p>

      <form className="mt-6 flex flex-col gap-3" onSubmit={onSubmit}>
        <Input
          id="admin-token"
          label={brand.copy.adminTokenLabel}
          onChange={(event) => onTokenChange(event.target.value)}
          required
          type="password"
          value={token}
        />
        <Button type="submit">{brand.copy.adminLogin}</Button>
      </form>

      {error ? (
        <Notice className="mt-4" tone="error">
          {error}
        </Notice>
      ) : null}
    </section>
  );
}
