type VideoPlayerProps = {
  src: string;
};

export default function VideoPlayer({ src }: VideoPlayerProps) {
  return (
    <video className="size-full bg-surface-2" controls preload="metadata" src={src} />
  );
}
