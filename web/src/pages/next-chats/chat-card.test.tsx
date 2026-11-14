import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ChatCard } from './chat-card';

jest.mock('./chat-dropdown', () => ({
  ChatDropdown: ({ children }: { children?: import('react').ReactNode }) =>
    children,
}));

function renderCard(name: string, prompt: Record<string, string> = {}) {
  return render(
    <MemoryRouter>
      <ChatCard
        data={
          {
            id: 'chat-1',
            name,
            prompt_config: prompt,
          } as unknown as import('@/interfaces/database/chat').IDialog
        }
        showChatRenameModal={jest.fn()}
      />
    </MemoryRouter>,
  );
}

test.each(['安全规章助手', '学习培训', '设备检修', '客运服务'])(
  'the name %s does not activate a railway classification',
  (name) => {
    renderCard(name);
    expect(screen.getByText('知识问答')).toBeInTheDocument();
  },
);

test('a railway scene needs an explicit railway domain', () => {
  renderCard('安全助手', { railway_scene: 'safety' });
  expect(screen.getByText('知识问答')).toBeInTheDocument();
});

test('a renamed railway assistant keeps its saved scene and chat destination', () => {
  renderCard('我的资料助手', { domain: 'railway', railway_scene: 'equipment' });
  expect(screen.getByText('设备与检修')).toBeInTheDocument();
  expect(screen.getByRole('link')).toHaveAttribute('href', '/chat/chat-1');
});

test.each(['unknown', 'toString', '__proto__'])(
  'an invalid saved scene %s falls back safely',
  (scene) => {
    renderCard('我的助手', { domain: 'railway', railway_scene: scene });
    expect(screen.getByText('知识问答')).toBeInTheDocument();
  },
);
