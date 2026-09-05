type PhotoPreviewProps = {
  alt: string;
  src: string;
};

export default function PhotoPreview({ alt, src }: PhotoPreviewProps) {
  return (
    <img alt={alt} className="size-full object-contain" src={src} />
  );
}
