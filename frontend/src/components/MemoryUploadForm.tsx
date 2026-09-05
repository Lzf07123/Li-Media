import type { ChangeEvent, FormEvent } from "react";

import { brand } from "@/lib/brand";
import Button from "@/components/ui/Button";
import { Input, TextArea } from "@/components/ui/Input";

type MemoryUploadFormProps = {
  capturedAt: string;
  description: string;
  file: File | null;
  isUploading: boolean;
  location: string;
  title: string;
  onCapturedAtChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onFileChange: (file: File | null) => void;
  onLocationChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export default function MemoryUploadForm({
  capturedAt,
  description,
  file,
  isUploading,
  location,
  title,
  onCapturedAtChange,
  onDescriptionChange,
  onFileChange,
  onLocationChange,
  onTitleChange,
  onSubmit,
}: MemoryUploadFormProps) {
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    onFileChange(event.target.files?.[0] ?? null);
  };

  return (
    <form className="card mt-6 grid gap-4 p-6 lg:grid-cols-2" onSubmit={onSubmit}>
      <Input
        id="memory-title"
        label={brand.copy.adminTitleLabel}
        onChange={(event) => onTitleChange(event.target.value)}
        value={title}
      />
      <Input
        id="memory-captured-at"
        label={brand.copy.adminCapturedAtLabel}
        onChange={(event) => onCapturedAtChange(event.target.value)}
        type="datetime-local"
        value={capturedAt}
      />
      <Input
        id="memory-location"
        label={brand.copy.adminLocationLabel}
        onChange={(event) => onLocationChange(event.target.value)}
        value={location}
      />
      <Input
        accept="image/*,video/*"
        id="memory-file"
        label={brand.copy.adminFileLabel}
        onChange={handleFileChange}
        required
        type="file"
      />
      <TextArea
        className="lg:col-span-2"
        id="memory-description"
        label={brand.copy.adminDescriptionLabel}
        onChange={(event) => onDescriptionChange(event.target.value)}
        value={description}
      />
      <Button className="lg:col-span-2" disabled={isUploading || !file} type="submit">
        {isUploading ? brand.copy.adminUploading : brand.copy.adminUpload}
      </Button>
    </form>
  );
}
