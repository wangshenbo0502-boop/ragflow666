import { claimChatPlayback } from './chat-playback';

it('stops previous playback and ignores a stale release', () => {
  const stopFirst = jest.fn();
  const releaseFirst = claimChatPlayback(stopFirst);
  const stopSecond = jest.fn();
  const releaseSecond = claimChatPlayback(stopSecond);
  expect(stopFirst).toHaveBeenCalledTimes(1);
  releaseFirst();
  const releaseThird = claimChatPlayback(jest.fn());
  expect(stopSecond).toHaveBeenCalledTimes(1);
  releaseSecond();
  releaseThird();
});
