import type { ChangeEvent, FormEvent } from "react";

import { brand } from "@/lib/brand";
import Button from "@/components/ui/Button";
import { Input, TextArea } from "@/components/ui/Input";

type MemoryUploadFormProps = {
  capturedAt: string;
  description: string;
  files: File[];
  isUploading: boolean;
  location: string;
  title: string;
  onCapturedAtChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onFilesChange: (files: File[]) => void;
  onLocationChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export default function MemoryUploadForm({
  capturedAt,
  description,
  files,
  isUploading,
  location,
  title,
  onCapturedAtChange,
  onDescriptionChange,
  onFilesChange,
  onLocationChange,
  onTitleChange,
  onSubmit,
}: MemoryUploadFormProps) {
  const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    onFilesChange(Array.from(event.target.files ?? []));
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
        onChange={handleFilesChange}
        required
        multiple
        type="file"
      />
      <TextArea
        className="lg:col-span-2"
        id="memory-description"
        label={brand.copy.adminDescriptionLabel}
        onChange={(event) => onDescriptionChange(event.target.value)}
        value={description}
      />
      <Button className="lg:col-span-2" disabled={isUploading || files.length === 0} type="submit">
        {isUploading ? brand.copy.adminUploading : brand.copy.adminUpload}
      </Button>
    </form>
  );
}
