import { Button } from '@/components/ui/button';
import { RailScrollDiagram } from '@/components/rail-scroll-diagram';
import { RailArchiveDiagram } from '@/components/rail-archive-diagram';
import { RailListState } from '@/components/rail-list-state';
import { IngestionTaskStatus } from '@/constants/knowledge';
import { useRailMotion } from '@/hooks/use-rail-motion';
import type { RailwayScene } from '@/interfaces/database/railway';
import dayjs from 'dayjs';
import {
  ArrowDownToLine,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  FileText,
  GraduationCap,
  LoaderCircle,
  ShieldCheck,
  Ticket,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { EquipmentIntake } from './equipment-intake';
import { useRailwayWorkbench } from './use-railway-workbench';

const Scenes = [
  {
    value: 'safety',
    label: '安全规章',
    icon: ShieldCheck,
    hint: '查规章，核对作业与安全要求',
  },
  {
    value: 'passenger',
    label: '客运服务',
    icon: Ticket,
    hint: '查客规，解答旅客运输问题',
  },
  {
    value: 'equipment',
    label: '设备分析',
    icon: Wrench,
    hint: '记录设备现象，查找分析依据',
  },
  {
    value: 'training',
    label: '学习培训',
    icon: GraduationCap,
    hint: '梳理知识，理解业务与规章',
  },
] as const;

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

function WorkbenchStage({
  id,
  index,
  label,
  title,
  description,
  children,
}: {
  id?: string;
  index: string;
  label: string;
  title: [string, string];
  description: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      className="rail-stage"
      aria-labelledby={headingId}
      data-rail-stage
    >
      <div className="rail-stage-label" data-rail-reveal>
        <span className="rail-section-index">{index}</span>
        <span>{label}</span>
        <div className="rail-stage-line" aria-hidden />
      </div>
      <div className="rail-stage-content">
        <header>
          <h2 id={headingId} className="rail-statement" data-rail-reveal>
            <span>{title[0]}</span>
            <span>{title[1]}</span>
          </h2>
          <p className="rail-stage-description" data-rail-reveal>
            {description}
          </p>
        </header>
        <div data-rail-reveal>{children}</div>
      </div>
    </section>
  );
}

export default function Home() {
  const { hash, key } = useLocation();
  const workbench = useRailwayWorkbench();
  const pageRef = useRef<HTMLElement>(null);
  useRailMotion(pageRef);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const startingRef = useRef(false);
  const activeScene = Scenes.find((scene) => scene.value === workbench.scene)!;
  const selectedDataset = workbench.datasets.data?.find(
    (dataset) => dataset.id === workbench.selectedId,
  );
  const documentCount = workbench.documents.data?.length || 0;
  const handleScene = (event: React.MouseEvent<HTMLButtonElement>) =>
    workbench.setScene(event.currentTarget.dataset.scene as RailwayScene);
  const handleDataset = (event: React.ChangeEvent<HTMLSelectElement>) =>
    workbench.setDatasetId(event.target.value);
  const handleImport = () => workbench.initialize.mutate();
  const handleStart = () => {
    if (!workbench.canStart || workbench.start.isPending || startingRef.current)
      return;

    startingRef.current = true;
    workbench.start.mutate(undefined, {
      onSettled: () => {
        startingRef.current = false;
      },
    });
  };
  const handleFocusQuestion = useCallback(() => {
    const workspace = document.getElementById('rail-workspace');
    const questionInput = questionRef.current;
    const page = pageRef.current;
    if (!workspace || !questionInput || !page) return;

    const questionBottom =
      questionInput.getBoundingClientRect().bottom -
      workspace.getBoundingClientRect().top;
    if (questionBottom > page.getBoundingClientRect().height) {
      questionInput.scrollIntoView({ block: 'center' });
    } else {
      workspace.scrollIntoView({ block: 'start' });
    }
    questionInput.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (hash !== '#rail-workspace') return;
    const frame = requestAnimationFrame(handleFocusQuestion);
    return () => cancelAnimationFrame(frame);
  }, [hash, key, handleFocusQuestion]);
  const handleQuestion = (event: React.ChangeEvent<HTMLTextAreaElement>) =>
    workbench.setQuestion(event.target.value);
  const handleExample = (event: React.MouseEvent<HTMLButtonElement>) => {
    workbench.setQuestion(event.currentTarget.dataset.question || '');
    questionRef.current?.focus();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      handleStart();
    }
  };
  const error =
    workbench.initialize.error ||
    workbench.start.error ||
    workbench.datasets.error ||
    workbench.documents.error;
  const readingSources =
    workbench.datasets.isPending ||
    (!!workbench.selectedId && workbench.documents.isPending);
  const sourcesError =
    workbench.datasets.isError || workbench.documents.isError;

  let unavailableReason = '';
  let preparationSummary = `${workbench.readyDocumentCount} 份资料已就绪`;
  if (sourcesError) {
    preparationSummary = '资料读取失败';
  } else if (readingSources) {
    preparationSummary = '正在读取资料…';
    unavailableReason = '正在读取知识库…';
  } else if (!workbench.selectedId) {
    preparationSummary = '未选择知识库';
  } else if (documentCount === 0) {
    preparationSummary = '暂无资料';
  } else if (
    workbench.readyDocumentCount === 0 &&
    workbench.documents.data?.some(
      (doc) => doc.ingestion_status === IngestionTaskStatus.FAILED,
    )
  ) {
    preparationSummary = '有资料解析失败';
  }

  if (!sourcesError && !readingSources && !workbench.canStart) {
    if (!workbench.models.llm_id) {
      unavailableReason = '请先配置对话模型';
    } else if (!workbench.selectedId) {
      unavailableReason = '请选择知识库，或导入官方资料';
    } else if (documentCount === 0) {
      unavailableReason = '当前知识库暂无资料，请先添加资料';
    } else {
      unavailableReason = '资料完成解析后即可开始对话';
    }
  }

  return (
    <article ref={pageRef} className="rail-page rail-workbench">
      <header className="rail-workbench-heading">
        <img src="/railway/railway-landscape.jpg" alt="" />
        <div className="rail-page-inner rail-hero-inner">
          <div className="rail-hero-copy">
            <p className="rail-eyebrow">
              <i className="rail-status-dot" aria-hidden />
              RAILMIND <span>/</span> 铁路知识工作空间
            </p>
            <h1>轨知 RailMind</h1>
            <p className="rail-hero-tagline">铁路知识，有据可循</p>
            <p className="rail-hero-description">
              连接规章、资料与现场问题，找到有依据的答案。
            </p>
            <div className="rail-hero-actions">
              <Button className="rail-primary" onClick={handleFocusQuestion}>
                开始铁路提问
                <ArrowUpRight className="size-4" />
              </Button>
              <Link to="/chats" className="rail-text-link">
                我的铁路问答
              </Link>
            </div>
          </div>
          <div className="rail-hero-footer">
            <span>
              铁路知识与故障分析辅助
              <span className="rail-hero-divider">/</span>
              {preparationSummary}
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={handleFocusQuestion}
              aria-label="前往铁路提问"
            >
              WORKSPACE <ArrowDown className="size-3" />
            </Button>
          </div>
        </div>
      </header>
      <div className="rail-page-inner rail-stage-stack">
        <WorkbenchStage
          id="rail-workspace"
          index="01 / WORKSPACE"
          label="从一个问题开始"
          title={['你想了解的，', '让知识来回答']}
          description="选择铁路场景和资料范围，开始一次有依据的问答。"
        >
          <div className="rail-scene-tabs" role="group" aria-label="问答场景">
            {Scenes.map(({ value, label, icon: Icon }) => (
              <Button
                key={value}
                type="button"
                variant="ghost"
                data-scene={value}
                aria-pressed={workbench.scene === value}
                onClick={handleScene}
              >
                <Icon className="size-4" />
                <span>{label}</span>
              </Button>
            ))}
          </div>
          <div className="rail-composer">
            {workbench.scene === 'equipment' && (
              <div className="rail-equipment-fields">
                <EquipmentIntake
                  value={workbench.equipment}
                  onChange={workbench.setEquipment}
                />
              </div>
            )}
            <textarea
              ref={questionRef}
              id="railway-question"
              aria-label="铁路问题"
              value={workbench.question}
              onChange={handleQuestion}
              onKeyDown={handleKeyDown}
              placeholder={activeScene.hint + '…'}
            />
            <div className="rail-composer-footer">
              <div className="rail-dataset-select">
                <BookOpen className="size-4 shrink-0" />
                <select
                  aria-label="资料范围"
                  title={selectedDataset?.name}
                  value={workbench.selectedId}
                  onChange={handleDataset}
                >
                  <option value="">选择铁路知识库</option>
                  {workbench.datasets.data?.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="size-3.5 shrink-0" />
              </div>
              <Button
                className="rail-primary rail-start-button"
                onClick={handleStart}
                disabled={!workbench.canStart || workbench.start.isPending}
                aria-label="开始铁路对话"
              >
                {workbench.start.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
                <span>
                  {workbench.start.isPending ? '正在创建' : '开始对话'}
                </span>
              </Button>
            </div>
          </div>
          {unavailableReason && (
            <p className="rail-form-status" role="status">
              {unavailableReason}
            </p>
          )}
          {error && (
            <p role="alert" className="rail-error">
              {error.message}
            </p>
          )}
          <div className="rail-suggestion">
            <span>试着问</span>
            <button
              type="button"
              data-question={Questions[workbench.scene][0]}
              onClick={handleExample}
            >
              <span>{Questions[workbench.scene][0]}</span>
              <ArrowUpRight className="size-3.5 shrink-0" />
            </button>
          </div>
          <details className="rail-preparation">
            <summary>
              <span>
                <i className="rail-status-dot" aria-hidden />
                知识与模型准备
              </span>
              <span>
                {preparationSummary}
                <ChevronDown className="size-3.5 shrink-0" />
              </span>
            </summary>
            <div className="rail-preparation-body">
              <div className="rail-preparation-links">
                <Link to="/datasets">
                  管理知识库 <ArrowUpRight className="size-3.5" />
                </Link>
                <Link to="/user-setting/model">
                  模型设置 <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
              <p className="rail-form-status">
                对话模型{workbench.models.llm_id ? '已就绪' : '待配置'} ·
                嵌入模型{workbench.models.embd_id ? '已就绪' : '待配置'}
              </p>
              <Button
                variant="outline"
                className="rail-import-button"
                onClick={handleImport}
                disabled={
                  workbench.initialize.isPending || !workbench.models.embd_id
                }
              >
                {workbench.initialize.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ArrowDownToLine className="size-4" />
                )}
                导入官方铁路资料
              </Button>
              {workbench.progress && (
                <p role="status" className="rail-form-status">
                  {workbench.progress}
                </p>
              )}
              {!!documentCount && (
                <details className="rail-document-details">
                  <summary>
                    查看资料解析状态
                    <ChevronDown className="size-4" />
                  </summary>
                  <ul>
                    {workbench.documents.data?.map((doc) => (
                      <li key={doc.id}>
                        <div>
                          <FileText className="size-3.5 shrink-0" />
                          <span>{doc.name}</span>
                          <small>
                            {DocumentStatuses[doc.ingestion_status] || '待确认'}
                          </small>
                        </div>
                        {doc.ingestion_status ===
                          IngestionTaskStatus.FAILED && (
                          <p className="rail-error">
                            {doc.progress_msg ||
                              '解析失败，请检查模型和任务服务后重试'}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </details>
          <p className="rail-safety-note">
            回答仅供参考，现场作业以有效规程和应急预案为准。
          </p>
        </WorkbenchStage>
        <WorkbenchStage
          index="02 / KNOWLEDGE"
          label="连接业务资料"
          title={['分散的资料，', '相连的知识']}
          description="安全规章、客运资料与设备记录，汇入同一个知识目录。"
        >
          <div className="rail-diagram-band" data-rail-diagram-stage>
            <RailScrollDiagram variant="server" />
          </div>
          <div className="rail-stage-actions">
            <span>{preparationSummary}</span>
            <Link to="/datasets" className="rail-text-link">
              管理知识库 <ArrowUpRight className="size-4" />
            </Link>
          </div>
        </WorkbenchStage>
        <WorkbenchStage
          index="03 / ARCHIVE"
          label="保留原文证据"
          title={['官方资料，', '有源可循']}
          description="资料保留发布机构、原文链接和采集日期，便于核对依据。"
        >
          <div className="rail-diagram-band" data-rail-diagram-stage>
            <RailScrollDiagram variant="browser" />
          </div>
          <div className="rail-stage-actions">
            <span>原文与采集记录</span>
            <a href="#rail-sources" className="rail-text-link">
              查阅资料来源 <ArrowDown className="size-4" />
            </a>
          </div>
        </WorkbenchStage>
        <WorkbenchStage
          id="rail-sources"
          index="04 / SOURCES"
          label="查阅发布原文"
          title={['铁路资料，', '来源目录']}
          description="铁路规章与业务资料的发布机构及采集记录。"
        >
          <div className="rail-source-layout">
            <div className="rail-source-grid">
              {workbench.sources.isPending ? (
                <RailListState loading label="正在读取资料来源" />
              ) : workbench.sources.isError ? (
                <RailListState
                  error
                  label="无法读取资料来源"
                  onRetry={workbench.sources.refetch}
                />
              ) : !workbench.sources.data?.length ? (
                <RailListState label="暂无资料来源" icon={FileText} />
              ) : null}
              {workbench.sources.data?.map((source) => (
                <a
                  key={source.id}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rail-source"
                >
                  <FileText className="size-4 shrink-0" />
                  <div>
                    <h3>{source.title}</h3>
                    <p>
                      {source.publisher} · 采集于{' '}
                      {dayjs(source.collectedAt).format('YYYY.MM.DD')}
                    </p>
                  </div>
                  <ArrowUpRight className="size-4 shrink-0" />
                </a>
              ))}
            </div>
            <div className="rail-source-diagram" data-rail-diagram-stage>
              <RailArchiveDiagram />
            </div>
          </div>
        </WorkbenchStage>
        <footer className="rail-page-caption">
          <span>轨知 RailMind</span>
          <span>铁路知识与故障分析辅助</span>
        </footer>
      </div>
    </article>
  );
}
