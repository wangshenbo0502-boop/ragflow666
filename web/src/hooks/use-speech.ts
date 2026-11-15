import chatService from '@/services/next-chat-service';
import { removeThinkSection } from '@/utils/chat';
import { hexStringToUint8Array } from '@/utils/common-util';
import notification from '@/utils/notification';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const useSpeech = (content: string, audioBinary?: string) => {
  const ref = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<AbortController>();
  const objectUrlRef = useRef<string>();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation();

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    ref.current?.pause();
    setIsPlaying(false);
    setIsLoading(false);
  }, []);

  const handleRead = useCallback(async () => {
    if (isPlaying || isLoading) {
      stop();
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoading(true);
    try {
      const text = removeThinkSection(content)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/[#*`_]/g, '')
        .trim();
      if (!text && !audioBinary) return;
      const units = audioBinary ? hexStringToUint8Array(audioBinary) : null;
      const blob = units
        ? new Blob([new Uint8Array(units)], {
            type:
              String.fromCharCode(...units.slice(0, 4)) === 'RIFF'
                ? 'audio/wav'
                : 'audio/mpeg',
          })
        : ((
            await chatService.chatsTts(
              {
                data: { text },
                responseType: 'blob',
                signal: controller.signal,
                timeout: 600000,
              },
              true,
            )
          ).data as Blob);
      if (controller.signal.aborted) return;
      if (blob.type.includes('json')) {
        const error = JSON.parse(await blob.text());
        throw new Error(error.message || t('message.requestError'));
      }
      if (!blob.size) throw new Error(t('message.requestError'));
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(blob);
      const audio = ref.current;
      if (!audio) return;
      audio.src = objectUrlRef.current;
      audio.onended = () => setIsPlaying(false);
      audio.onpause = () => setIsPlaying(false);
      await audio.play();
      if (controller.signal.aborted) audio.pause();
      else setIsPlaying(true);
    } catch (error) {
      if (!controller.signal.aborted) {
        setIsPlaying(false);
        notification.error({
          message: t('message.requestError'),
          description: error instanceof Error ? error.message : undefined,
        });
      }
    } finally {
      if (controllerRef.current === controller) {
        setIsLoading(false);
        controllerRef.current = undefined;
      }
    }
  }, [isPlaying, isLoading, stop, content, audioBinary, t]);

  useEffect(() => {
    const audio = ref.current;
    setIsLoading(false);
    setIsPlaying(false);
    return () => {
      controllerRef.current?.abort();
      audio?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [content, audioBinary]);

  return { ref, handleRead, isPlaying, isLoading };
};
