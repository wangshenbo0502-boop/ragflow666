import { fireEvent, render, screen } from '@testing-library/react';
import { ChatMediaContext, ChatMediaImage } from './chat-media-image';

jest.mock('@/components/image', () => ({
  AuthenticatedImg: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <img {...props} />
  ),
}));
jest.mock('@/services/chat-media-service', () => ({
  downloadChatMedia: jest.fn(),
}));

const Parent = {
  id: 'older-parent',
  kind: 'image' as const,
  url: '/parent.png',
  mime_type: 'image/png',
  width: 2048,
  height: 1152,
};
const Edited = {
  ...Parent,
  id: 'edited-image',
  url: '/edited.png',
  parent_id: Parent.id,
};

it('views the actual parent without changing the selected edit target', () => {
  const onView = jest.fn();
  const onEdit = jest.fn();
  render(
    <ChatMediaContext.Provider
      value={{ assets: [Parent, Edited], onView, onEdit }}
    >
      <ChatMediaImage src={Edited.url} alt="Edited image" />
    </ChatMediaContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '查看父版本' }));
  expect(onView).toHaveBeenCalledWith(Parent);
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑这张图片' }));
  expect(onEdit).toHaveBeenCalledWith(Edited);
});

it.each([
  { asset: Parent, assets: [Parent] },
  { asset: Edited, assets: [Edited] },
])(
  'does not offer an unavailable or nonexistent parent',
  ({ asset, assets }) => {
    render(
      <ChatMediaContext.Provider value={{ assets, onView: jest.fn() }}>
        <ChatMediaImage src={asset.url} alt="Image" />
      </ChatMediaContext.Provider>,
    );
    expect(
      screen.queryByRole('button', { name: '查看父版本' }),
    ).not.toBeInTheDocument();
  },
);
