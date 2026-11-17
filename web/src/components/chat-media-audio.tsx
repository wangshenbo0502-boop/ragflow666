import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  downloadChatMedia,
  fetchChatAudio,
} from '@/services/chat-media-service';
import { claimChatPlayback } from '@/utils/chat-playback';
import { Download, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

export const ChatMediaAudio = ({ src }: { src: string }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const releaseRef = useRef<() => void>();
  const requestRef = useRef<AbortController>();
  const downloadRef = useRef<AbortController>();
  const objectUrlRef = useRef('');
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const handlePause = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = undefined;
    audioRef.current?.pause();
    releaseRef.current?.();
    releaseRef.current = undefined;
    setPlaying(false);
    setBusy(false);
  }, []);
  const handlePlay = useCallback(async () => {
    if (playing || requestRef.current) {
      handlePause();
      return;
    }
    const request = new AbortController();
    requestRef.current = request;
    releaseRef.current = claimChatPlayback(handlePause);
    setBusy(true);
    setError('');
    try {
      // Revalidate permission for every playback, including a resumed blob.
      const blob = await fetchChatAudio(src, request.signal);
      if (
        requestRef.current !== request ||
        request.signal.aborted ||
        !audioRef.current
      )
        return;
      const position = audioRef.current.currentTime;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(blob);
      audioRef.current.src = objectUrlRef.current;
      audioRef.current.currentTime = position;
      await audioRef.current.play();
      if (requestRef.current !== request || request.signal.aborted) return;
      setPlaying(true);
    } catch {
      if (requestRef.current === request && !request.signal.aborted) {
        handlePause();
        setError('音频不可用，请重试');
      }
    } finally {
      if (requestRef.current === request && !request.signal.aborted) {
        requestRef.current = undefined;
        setBusy(false);
      }
    }
  }, [src, playing, handlePause]);
  const handleDownload = useCallback(async () => {
    downloadRef.current?.abort();
    const request = new AbortController();
    downloadRef.current = request;
    setDownloading(true);
    setError('');
    try {
      await downloadChatMedia(src, request.signal);
    } catch {
      if (downloadRef.current === request && !request.signal.aborted)
        setError('下载失败，请重试');
    } finally {
      if (downloadRef.current === request && !request.signal.aborted)
        setDownloading(false);
    }
  }, [src]);
  const handleProgress = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setPosition(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
  }, []);
  const handleSeek = useCallback((values: number[]) => {
    if (audioRef.current) audioRef.current.currentTime = values[0];
    setPosition(values[0]);
  }, []);
  useEffect(() => {
    const audio = audioRef.current;
    setPlaying(false);
    setBusy(false);
    setDownloading(false);
    setPosition(0);
    setDuration(0);
    setError('');
    return () => {
      requestRef.current?.abort();
      requestRef.current = undefined;
      downloadRef.current?.abort();
      downloadRef.current = undefined;
      audio?.pause();
      releaseRef.current?.();
      releaseRef.current = undefined;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      if (audio) {
        audio.removeAttribute('src');
        audio.load();
      }
    };
  }, [src]);
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        onClick={handlePlay}
        title={playing || busy ? '暂停' : '播放语音'}
        aria-label={playing || busy ? '暂停' : '播放语音'}
      >
        {playing || busy ? <Pause size={16} /> : <Play size={16} />}
      </Button>
      <audio
        ref={audioRef}
        onEnded={handlePause}
        onTimeUpdate={handleProgress}
        onLoadedMetadata={handleProgress}
        preload="none"
        aria-label="语音"
      />
      <Slider
        className="w-28 shrink-0"
        aria-label="播放进度"
        value={[position]}
        max={duration || 1}
        step={0.1}
        disabled={!duration || busy}
        onValueChange={handleSeek}
      />
      <span role="status" className="text-sm text-text-secondary">
        {busy ? '加载中' : playing ? '播放中' : '语音'}
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleDownload}
        disabled={downloading}
        title="下载语音"
        aria-label="下载语音"
      >
        <Download size={16} />
      </Button>
      {error && (
        <span role="alert" className="break-words text-sm text-state-error">
          {error}
        </span>
      )}
    </span>
  );
};
