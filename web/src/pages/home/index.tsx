import { Button } from '@/components/ui/button';
import { IngestionTaskStatus } from '@/constants/knowledge';
import type { RailwayScene } from '@/interfaces/database/railway';
import dayjs from 'dayjs';
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  GraduationCap,
  LoaderCircle,
  MessagesSquare,
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
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const activeScene = Scenes.find((scene) => scene.value === workbench.scene)!;
  const SceneIcon = activeScene.icon;
  const documentCount = workbench.documents.data?.length || 0;
  const handleScene = (event: React.MouseEvent<HTMLButtonElement>) =>
    workbench.setScene(event.currentTarget.dataset.scene as RailwayScene);
  const handleDataset = (event: React.ChangeEvent<HTMLSelectElement>) =>
    workbench.setDatasetId(event.target.value);
  const handleImport = () => workbench.initialize.mutate();
  const handleStart = () => workbench.start.mutate();
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
    <article className="rail-page rail-workbench">
      <div className="rail-page-inner">
        <header className="rail-page-heading">
          <div>
            <p className="rail-eyebrow">
              工作空间 <span>/</span> WORKSPACE
            </p>
            <h1>铁路工作台</h1>
            <p>从一个问题开始，找到有依据的答案。</p>
          </div>
          <Link to="/chats" className="rail-secondary-link">
            <MessagesSquare className="size-4" />
            我的铁路问答
            <ArrowUpRight className="size-4" />
          </Link>
        </header>
        <div className="rail-workspace">
          <section className="rail-question-space" aria-label="铁路提问">
            <div className="rail-section-title">
              <span className="rail-section-index">01</span>
              <h2>你想了解什么？</h2>
            </div>
            <div className="rail-scene-tabs" role="group" aria-label="问答场景">
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
              <div className="rail-composer-context">
                <SceneIcon className="size-4" />
                <span>{activeScene.hint}</span>
              </div>
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
                placeholder="描述你的问题，或从下方选择一个问题…"
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
            <div className="rail-examples">
              <h3>
                试着问一问 <span>{activeScene.label}</span>
              </h3>
              {Questions[workbench.scene].map((question) => (
                <button
                  key={question}
                  type="button"
                  data-question={question}
                  onClick={handleExample}
                >
                  <MessagesSquare className="size-4" />
                  <span>{question}</span>
                  <ArrowUpRight className="size-4" />
                </button>
              ))}
            </div>
            <div className="rail-safety-note">
              <ShieldCheck className="size-4 shrink-0" />
              <p>
                回答仅供参考。现场作业以有效规程、授权人员及应急预案为准；实时票务请通过
                12306 核实。
              </p>
            </div>
          </section>
          <aside className="rail-context-space" aria-label="知识与模型准备">
            <div className="rail-section-title">
              <span className="rail-section-index">02</span>
              <h2>知识准备</h2>
              <Link to="/datasets" aria-label="管理知识库" title="管理知识库">
                <ArrowUpRight className="size-4" />
              </Link>
            </div>
            <div className="rail-ready-overview">
              <div>
                <BookOpen className="size-5" />
                <span>可用资料</span>
              </div>
              <p>
                <strong>
                  {workbench.readyDocumentCount.toString().padStart(2, '0')}
                </strong>
                <span>
                  / {documentCount.toString().padStart(2, '0')} 份已解析
                </span>
              </p>
              <progress
                aria-label="资料解析进度"
                max={Math.max(documentCount, 1)}
                value={workbench.readyDocumentCount}
              />
            </div>
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
                      {doc.ingestion_status === IngestionTaskStatus.FAILED && (
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
            <div className="rail-model-status">
              <h3>
                模型配置
                <Link
                  to="/user-setting/model"
                  aria-label="模型设置"
                  title="模型设置"
                >
                  <ArrowUpRight className="size-4" />
                </Link>
              </h3>
              <p>
                <span>对话模型</span>
                <span className={workbench.models.llm_id ? 'is-ready' : ''}>
                  {workbench.models.llm_id && <Check className="size-3.5" />}
                  {workbench.models.llm_id ? '已就绪' : '待配置'}
                </span>
              </p>
              <p>
                <span>嵌入模型</span>
                <span className={workbench.models.embd_id ? 'is-ready' : ''}>
                  {workbench.models.embd_id && <Check className="size-3.5" />}
                  {workbench.models.embd_id ? '已就绪' : '待配置'}
                </span>
              </p>
            </div>
            <p className="rail-context-note">
              公开规章可用于业务查询。设备故障分析还需补充合法取得的专业检修手册。
            </p>
          </aside>
        </div>
        <section className="rail-source-section">
          <div className="rail-section-title">
            <span className="rail-section-index">03</span>
            <h2>官方资料档案</h2>
            <span className="rail-source-caption">
              来源可追溯 · 适用版本需复核
            </span>
          </div>
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
        </section>
        <footer className="rail-page-caption">
          <span>轨知 RailMind</span>
          <span>铁路知识与故障分析辅助</span>
        </footer>
      </div>
    </article>
  );
}
