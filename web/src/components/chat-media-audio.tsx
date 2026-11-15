import { useAuthenticatedImageUrl } from '@/components/image';
import { useTranslation } from 'react-i18next';

export const ChatMediaAudio = ({ src }: { src: string }) => {
  const { src: audioUrl, status } = useAuthenticatedImageUrl(src);
  const { t } = useTranslation();
  if (status === 'error') {
    return <span role="alert">{t('message.requestError')}</span>;
  }
  return (
    <audio
      src={audioUrl || undefined}
      controls
      preload="metadata"
      className="block w-full max-w-96"
      aria-label="语音"
    />
  );
};
