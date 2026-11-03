import { Button } from '@/components/ui/button';
import { RailScrollHeading } from '@/components/rail-scroll-heading';
import { RailScrollDiagram } from '@/components/rail-scroll-diagram';
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
import { useRef } from 'react';
import { Link } from 'react-router';
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

export default function Home() {
  const workbench = useRailwayWorkbench();
  const pageRef = useRef<HTMLElement>(null);
  useRailMotion(pageRef);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const activeScene = Scenes.find((scene) => scene.value === workbench.scene)!;
  const documentCount = workbench.documents.data?.length || 0;
  const handleScene = (event: React.MouseEvent<HTMLButtonElement>) =>
    workbench.setScene(event.currentTarget.dataset.scene as RailwayScene);
  const handleDataset = (event: React.ChangeEvent<HTMLSelectElement>) =>
    workbench.setDatasetId(event.target.value);
  const handleImport = () => workbench.initialize.mutate();
  const handleStart = () => workbench.start.mutate();
  const handleFocusQuestion = () => {
    document
      .getElementById('rail-workspace')
      ?.scrollIntoView({ block: 'start' });
    questionRef.current?.focus({ preventScroll: true });
  };
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
      if (workbench.canStart && !workbench.start.isPending) handleStart();
    }
  };
  const error =
    workbench.initialize.error ||
    workbench.start.error ||
    workbench.datasets.error ||
    workbench.documents.error;
  const unavailableReason =
    workbench.datasets.isPending ||
    (workbench.selectedId && workbench.documents.isPending)
      ? '正在读取知识库…'
      : !workbench.models.llm_id
        ? '请先配置对话模型'
        : !workbench.selectedId
          ? '请选择知识库，或导入官方资料'
          : !workbench.canStart
            ? '资料完成解析后即可开始对话'
            : '';

  return (
    <article ref={pageRef} className="rail-page rail-workbench">
      <div className="rail-page-inner">
        <header className="rail-page-heading rail-workbench-heading">
          <div>
            <p className="rail-eyebrow">
              <i className="rail-status-dot" aria-hidden />
              RAILMIND <span>/</span> 铁路知识工作空间
            </p>
            <h1>
              轨知 RailMind.
              <span>
                <span className="rail-hero-phrase">铁路知识，</span>
                <wbr />
                <span className="rail-hero-phrase">有据可循。</span>
              </span>
            </h1>
            <p className="rail-hero-description">
              连接规章、资料与现场问题。从一个问题开始，
              <br className="max-sm:hidden" />
              找到有依据的答案。
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
              {workbench.readyDocumentCount} 份资料已就绪
            </span>
            <button
              type="button"
              onClick={handleFocusQuestion}
              aria-label="前往铁路提问"
            >
              WORKSPACE <ArrowDown className="size-3" />
            </button>
          </div>
        </header>
        <div className="rail-workspace" id="rail-workspace" data-rail-stage>
          <div className="rail-stage-label">
            <span className="rail-section-index">01 / WORKSPACE</span>
            <span>从一个问题开始</span>
            <div className="rail-stage-line" aria-hidden>
              <i />
            </div>
          </div>
          <section className="rail-question-space" aria-label="铁路提问">
            <RailScrollHeading lines={['你想了解的，', '让知识来回答。']} />
            <div data-rail-reveal>
              <div
                className="rail-scene-tabs"
                role="group"
                aria-label="问答场景"
              >
                {Scenes.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    data-scene={value}
                    aria-pressed={workbench.scene === value}
                    onClick={handleScene}
                  >
                    <Icon className="size-4" />
                    <span>{label}</span>
                  </button>
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
                    {workbench.readyDocumentCount} 份资料已就绪{' '}
                    <ChevronDown className="size-3.5" />
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
                      workbench.initialize.isPending ||
                      !workbench.models.embd_id
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
                                {DocumentStatuses[doc.ingestion_status] ||
                                  '待确认'}
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
            </div>
          </section>
        </div>
        <section
          className="rail-capability"
          data-rail-stage
          data-rail-diagram-stage
        >
          <div className="rail-capability-scene">
            <div className="rail-capability-copy">
              <p className="rail-section-index">02 / KNOWLEDGE</p>
              <RailScrollHeading lines={['分散的资料，', '相连的知识。']} />
              <p className="rail-capability-description">
                安全规章、客运资料、设备记录。
                <br />
                汇入知识库，让每一次提问都有依据。
              </p>
              <Link to="/datasets" className="rail-capability-link">
                管理知识库 <ArrowUpRight className="size-4" />
              </Link>
            </div>
            <RailScrollDiagram variant="server" />
          </div>
        </section>
        <section className="rail-archive-section">
          <div
            className="rail-capability"
            data-rail-stage
            data-rail-diagram-stage
          >
            <div className="rail-capability-scene">
              <div className="rail-capability-copy">
                <p className="rail-section-index">03 / ARCHIVE</p>
                <RailScrollHeading lines={['官方资料。', '有源可循。']} />
                <p className="rail-capability-description">
                  回到原文，核对依据。
                  <br />
                  每一份资料，都保留来源与采集日期。
                </p>
                <a href="#rail-sources" className="rail-capability-link">
                  查阅资料来源 <ArrowDown className="size-4" />
                </a>
              </div>
              <RailScrollDiagram variant="browser" />
            </div>
          </div>
          <div id="rail-sources" className="rail-archive-list">
            {workbench.sources.error && (
              <p role="alert" className="rail-error">
                {workbench.sources.error.message}
              </p>
            )}
            <div className="rail-source-grid">
              {workbench.sources.data?.map((source) => (
                <a
                  key={source.id}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rail-source"
                  data-rail-reveal
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
          </div>
        </section>
        <footer className="rail-page-caption">
          <span>轨知 RailMind</span>
          <span>铁路知识与故障分析辅助</span>
        </footer>
      </div>
    </article>
  );
}
