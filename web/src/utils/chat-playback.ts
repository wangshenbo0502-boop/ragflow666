type Playback = { stop: () => void };

let activePlayback: Playback | undefined;

export function claimChatPlayback(stop: () => void) {
  const previous = activePlayback;
  const playback = { stop };
  activePlayback = playback;
  previous?.stop();
  return () => {
    if (activePlayback === playback) activePlayback = undefined;
  };
}
