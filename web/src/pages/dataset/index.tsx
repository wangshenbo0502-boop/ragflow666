import { useFetchKnowledgeBaseConfiguration } from '@/hooks/use-knowledge-request';
import { KnowledgeBaseProvider } from '@/pages/dataset/contexts/knowledge-base-context';

import { Outlet } from 'react-router';
import { SideBar } from './sidebar';

export default function DatasetWrapper() {
  const { data, loading } = useFetchKnowledgeBaseConfiguration();

  return (
    <KnowledgeBaseProvider knowledgeBase={data} loading={loading}>
      <article className="rail-feature-shell">
        <SideBar dataset={data} />
        <div className="rail-feature-content">
          <Outlet />
        </div>
      </article>
    </KnowledgeBaseProvider>
  );
}
