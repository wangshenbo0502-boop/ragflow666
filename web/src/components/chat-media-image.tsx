import { AuthenticatedImg } from '@/components/image';
import { Button } from '@/components/ui/button';
import { ChatMediaAsset } from '@/interfaces/database/chat';
import { downloadChatMedia } from '@/services/chat-media-service';
import { CornerUpLeft, Download, Pencil } from 'lucide-react';
import { createContext, useCallback, useContext, useState } from 'react';

export const ChatMediaContext = createContext<{
  assets: ChatMediaAsset[];
  onEdit?: (asset: ChatMediaAsset) => void;
  onView?: (asset: ChatMediaAsset) => void;
}>({ assets: [] });

export function ChatMediaImage({
  src,
  alt,
  title,
}: {
  src: string;
  alt: string;
  title?: string;
}) {
  const { assets, onEdit, onView } = useContext(ChatMediaContext);
  const asset = assets.find((item) => item.url === src);
  const parent = assets.find((item) => item.id === asset?.parent_id);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const handleEdit = useCallback(() => {
    if (asset) onEdit?.(asset);
  }, [asset, onEdit]);
  const handleViewParent = useCallback(() => {
    if (parent) onView?.(parent);
  }, [parent, onView]);
  const handleDownload = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await downloadChatMedia(src, new AbortController().signal);
    } catch {
      setError('下载失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [src]);
  return (
    <span
      className="inline-flex max-w-full flex-col gap-1"
      data-chat-media-id={asset?.id}
    >
      <AuthenticatedImg
        alt={alt}
        title={title}
        src={src}
        className="max-w-full h-auto"
      />
      <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-text-secondary">
        {asset && (
          <span className="break-all">
            {asset.width} × {asset.height} · {asset.id.slice(0, 8)}
            {asset.parent_id
              ? ` ← ${parent?.id.slice(0, 8) ?? asset.parent_id.slice(0, 8)}`
              : ''}
          </span>
        )}
        {parent && onView && (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleViewParent}
            title={`查看父版本 ${parent.id.slice(0, 8)}`}
            aria-label="查看父版本"
          >
            <CornerUpLeft size={16} />
          </Button>
        )}
        {asset && onEdit && (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleEdit}
            title="继续编辑这张图片"
            aria-label="继续编辑这张图片"
          >
            <Pencil size={16} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDownload}
          disabled={busy}
          title="下载原图"
          aria-label="下载原图"
        >
          <Download size={16} />
        </Button>
      </span>
      {error && (
        <span role="alert" className="break-words text-sm text-state-error">
          {error}
        </span>
      )}
    </span>
  );
}
