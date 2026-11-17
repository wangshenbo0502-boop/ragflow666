import chatService from '@/services/next-chat-service';
import { fetchChatAudio } from '@/services/chat-media-service';
import { claimChatPlayback } from '@/utils/chat-playback';
import { hexStringToUint8Array } from '@/utils/common-util';
import notification from '@/utils/notification';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const useSpeech = (
  content: string,
  audioBinary?: string,
  audioUrl?: string,
) => {
  const ref = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<AbortController>();
  const playbackRef = useRef<AbortController>();
  const objectUrlRef = useRef<string>();
  const playingAudioRef = useRef<HTMLAudioElement>();
  const releaseRef = useRef<() => void>();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation();
  const finishPlayback = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = undefined;
    setIsPlaying(false);
  }, []);

  const stop = useCallback(() => {
    playbackRef.current = undefined;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    ref.current?.pause();
    releaseRef.current?.();
    releaseRef.current = undefined;
    setIsPlaying(false);
    setIsLoading(false);
  }, []);

  const handleRead = useCallback(async () => {
    if (isPlaying || isLoading) {
      stop();
      return;
    }
    releaseRef.current = claimChatPlayback(stop);
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoading(true);
    try {
      if (!content.trim() && !audioBinary && !audioUrl) return;
      const units = audioBinary ? hexStringToUint8Array(audioBinary) : null;
      const blob = audioUrl
        ? await fetchChatAudio(audioUrl, controller.signal)
        : units
          ? new Blob([new Uint8Array(units)], {
              type:
                String.fromCharCode(...units.slice(0, 4)) === 'RIFF'
                  ? 'audio/wav'
                  : 'audio/mpeg',
            })
          : ((
              await chatService.chatsTts(
                {
                  data: { text: content },
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
      playingAudioRef.current = audio;
      playbackRef.current = controller;
      audio.src = objectUrlRef.current;
      audio.onended = () => {
        if (playbackRef.current !== controller) return;
        playbackRef.current = undefined;
        finishPlayback();
      };
      audio.onpause = () => {
        if (playbackRef.current !== controller) return;
        playbackRef.current = undefined;
        finishPlayback();
      };
      await audio.play();
      if (
        controllerRef.current !== controller ||
        playbackRef.current !== controller ||
        controller.signal.aborted
      )
        return;
      setIsPlaying(true);
    } catch (error) {
      if (!controller.signal.aborted) {
        finishPlayback();
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
  }, [
    isPlaying,
    isLoading,
    stop,
    content,
    audioBinary,
    audioUrl,
    t,
    finishPlayback,
  ]);

  useEffect(() => {
    const audio = ref.current;
    setIsLoading(false);
    setIsPlaying(false);
    return () => {
      playbackRef.current = undefined;
      controllerRef.current?.abort();
      (playingAudioRef.current ?? audio)?.pause();
      releaseRef.current?.();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = undefined;
      }
    };
  }, [content, audioBinary, audioUrl]);

  return { ref, handleRead, isPlaying, isLoading };
};
