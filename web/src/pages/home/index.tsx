import { PageContainer } from '@/layouts/components/page-container';
import { IngestionTaskStatus } from '@/constants/knowledge';
import { Button } from '@/components/ui/button';
import { Segmented, type SegmentedValue } from '@/components/ui/segmented';
import type { RailwayScene } from '@/interfaces/database/railway';
import {
  ArrowRight,
  BookOpen,
  Download,
  LoaderCircle,
  ShieldCheck,
  TrainFront,
} from 'lucide-react';
import { Link } from 'react-router';
import dayjs from 'dayjs';
import { useRailwayWorkbench } from './use-railway-workbench';
import { EquipmentIntake } from './equipment-intake';

const Scenes = [
  { value: 'safety', label: '安全规章' },
  { value: 'passenger', label: '客运服务' },
  { value: 'equipment', label: '设备分析' },
  { value: 'training', label: '学习培训' },
];
const Questions: Record<RailwayScene, string[]> = {
  safety: [
    '铁路线路安全保护区有哪些规定？',
    '发现铁路安全隐患，应如何报告？',
    '铁路交通事故应急救援有哪些职责分工？',
  ],
  passenger: [
    '儿童乘车有哪些实名制要求？',
    '旅客安检有哪些权利和义务？',
    '旅客运输合同包含哪些内容？',
  ],
  equipment: [
    '铁路设备质量问题如何报告和追溯？',
    '故障分析前需要收集哪些设备信息？',
    '公开法规能否替代设备检修手册？',
  ],
  training: [
    '解释铁路线路安全保护区的概念。',
    '根据资料梳理旅客安检责任。',
    '比较事故应急救援与事故调查的职责。',
  ],
};

const DocumentStatuses: Record<string, string> = {
  UNSTART: '待解析',
  CREATED: '已排队',
  SCHEDULED: '已排队',
  RUNNING: '解析中',
  COMPLETED: '已完成',
  FAILED: '解析失败',
  STOPPED: '已取消',
  STOPPING: '正在停止',
};

const Home = () => {
  const workbench = useRailwayWorkbench();
  const handleScene = (value: SegmentedValue) =>
    workbench.setScene(value as RailwayScene);
  const handleDataset = (event: React.ChangeEvent<HTMLSelectElement>) =>
    workbench.setDatasetId(event.target.value);
  const handleImport = () => workbench.initialize.mutate();
  const handleStart = () => workbench.start.mutate();
  const handleQuestion = (event: React.ChangeEvent<HTMLTextAreaElement>) =>
    workbench.setQuestion(event.target.value);
  const handleExample = (event: React.MouseEvent<HTMLButtonElement>) =>
    workbench.setQuestion(event.currentTarget.dataset.question || '');
  const error =
    workbench.initialize.error ||
    workbench.start.error ||
    workbench.datasets.error ||
    workbench.documents.error;
  return (
    <PageContainer>
      <article className="mx-auto max-w-6xl py-4 text-text-primary">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border-button pb-6">
          <div>
            <div className="flex items-center gap-3">
              <TrainFront className="size-8 text-accent-primary" />
              <h1 className="text-2xl font-semibold">轨知 RailMind</h1>
            </div>
            <p className="mt-2 text-sm text-text-secondary">
              铁路知识与故障分析辅助智能体
            </p>
          </div>
          <Link to="/chats" className="inline-flex items-center gap-2 text-sm">
            会话管理 <ArrowRight className="size-4" />
          </Link>
        </header>
        <div className="grid min-w-0 gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.65fr)]">
          <section className="min-w-0">
            <h2 className="mb-4 text-lg font-semibold">铁路问答</h2>
            <Segmented
              options={Scenes}
              value={workbench.scene}
              onChange={handleScene}
              buttonSize="sm"
              className="gap-1"
              itemClassName="min-w-0 flex-1 px-1 text-xs sm:text-sm"
              activeClassName="font-medium !text-accent-primary"
            />
            <label className="mt-6 block text-sm" htmlFor="railway-dataset">
              资料范围
            </label>
            <select
              id="railway-dataset"
              value={workbench.selectedId}
              onChange={handleDataset}
              className="mt-2 h-11 w-full rounded-md border border-border-button bg-bg-base px-3 text-sm"
            >
              <option value="">选择铁路知识库</option>
              {workbench.datasets.data?.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name} · {dataset.chunk_count || 0} 个片段
                </option>
              ))}
            </select>
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-text-secondary">
              <span>
                对话模型：{workbench.models.llm_id ? '已配置' : '未配置'}
              </span>
              <span>
                嵌入模型：{workbench.models.embd_id ? '已配置' : '未配置'}
              </span>
              <Link to="/user-setting/model" className="underline">
                模型设置
              </Link>
            </div>
            {workbench.scene === 'equipment' && (
              <EquipmentIntake
                value={workbench.equipment}
                onChange={workbench.setEquipment}
              />
            )}
            <textarea
              aria-label="铁路问题"
              value={workbench.question}
              onChange={handleQuestion}
              placeholder="描述铁路问题、设备现象或需要查询的规章"
              className="mt-5 min-h-32 w-full resize-y rounded-md border border-border-button bg-bg-base p-3 text-sm"
            />
            <Button
              variant="accent"
              onClick={handleStart}
              disabled={!workbench.canStart || workbench.start.isPending}
              className="mt-6 w-full gap-2"
            >
              {workbench.start.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <ArrowRight className="size-4" />
              )}
              开始铁路对话
            </Button>
            <h3 className="mb-3 mt-8 text-sm font-medium">问题示例</h3>
            <ul className="divide-y divide-border-button text-sm text-text-secondary">
              {Questions[workbench.scene].map((question) => (
                <li key={question}>
                  <button
                    type="button"
                    data-question={question}
                    onClick={handleExample}
                    className="flex w-full items-start justify-between gap-2 py-3 text-left hover:text-text-primary"
                  >
                    <span>{question}</span>
                    <ArrowRight className="mt-0.5 size-4 shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-6 flex items-start gap-2 border-t border-border-button pt-4 text-xs leading-6 text-text-secondary">
              <ShieldCheck className="mt-1 size-4 shrink-0" />
              <p>
                公开法规不能替代设备维修手册。现场作业和行车处置以授权人员、有效规程及应急预案为准；实时票务请通过12306核实。
              </p>
            </div>
          </section>
          <section className="min-w-0 border-t border-border-button pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <BookOpen className="size-5" />
                知识库准备
              </h2>
              <Link to="/datasets" className="text-sm underline">
                管理
              </Link>
            </div>
            <Button
              variant="outline"
              className="mt-5 w-full gap-2"
              onClick={handleImport}
              disabled={
                workbench.initialize.isPending || !workbench.models.embd_id
              }
            >
              {workbench.initialize.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              导入官方铁路资料
            </Button>
            {workbench.progress && (
              <p
                role="status"
                className="mt-3 text-sm leading-6 text-text-secondary"
              >
                {workbench.progress}
              </p>
            )}
            {error && (
              <p role="alert" className="mt-3 break-words text-sm">
                {error.message}
              </p>
            )}
            {workbench.selectedId && (
              <div className="mt-5 border-y border-border-button py-4">
                <p className="text-sm">
                  解析完成：{workbench.readyDocumentCount} /{' '}
                  {workbench.documents.data?.length || 0}
                </p>
                <ul className="mt-3 space-y-2 text-xs text-text-secondary">
                  {workbench.documents.data?.map((doc) => (
                    <li
                      key={doc.id}
                      className="flex flex-wrap justify-between gap-2"
                    >
                      <span className="break-all">{doc.name}</span>
                      <span>
                        {DocumentStatuses[doc.ingestion_status] || '待确认'}
                      </span>
                      {doc.ingestion_status === IngestionTaskStatus.FAILED && (
                        <p className="w-full break-words">
                          {doc.progress_msg ||
                            '解析失败，请检查模型和任务服务后重试'}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <h3 className="mt-6 text-sm font-medium">官方资料档案</h3>
            {workbench.sources.error && (
              <p role="alert" className="mt-3 text-sm">
                {workbench.sources.error.message}
              </p>
            )}
            <ul className="mt-2 divide-y divide-border-button">
              {workbench.sources.data?.map((source) => (
                <li key={source.id} className="py-3">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm hover:underline"
                  >
                    {source.title}
                  </a>
                  <p className="mt-1 text-xs text-text-secondary">
                    {source.publisher} · 采集{' '}
                    {dayjs(source.collectedAt).format('YYYY-MM-DD')}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-6 text-text-secondary">
              官方网页存档，适用版本需复核。资料上传后须完成解析；设备检修知识还需补充合法取得的专业手册。
            </p>
          </section>
        </div>
      </article>
    </PageContainer>
  );
};

export default Home;
