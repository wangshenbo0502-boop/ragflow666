/*
 *  Copyright 2026 The InfiniFlow Authors. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

'use client';

import {
  FileUpload,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemMetadata,
  FileUploadItemPreview,
  FileUploadItemProgress,
  FileUploadList,
  FileUploadTrigger,
  type FileUploadProps,
} from '@/components/file-upload';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  CircleStop,
  Globe,
  ImagePlus,
  Paperclip,
  RotateCw,
  Send,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  setThinkingLevel,
  ThinkingMode,
  useThinkingLevel,
} from '@/hooks/use-thinking-level';
import { SelectWithSearch } from '../originui/select-with-search';

export type NextMessageInputOnPressEnterParameter = {
  enableThinking?: string;
  enableInternet?: boolean;
  storeHistoryMessages?: boolean;
  omitSessionId?: boolean;
};

interface NextMessageInputProps {
  disabled: boolean;
  value: string;
  sendDisabled: boolean;
  sendLoading: boolean;
  conversationId: string;
  uploadMethod?: string;
  isShared?: boolean;
  showUploadIcon?: boolean;
  isUploading?: boolean;
  onPressEnter({
    enableThinking,
    enableInternet,
  }: NextMessageInputOnPressEnterParameter):
    | void
    | boolean
    | Promise<void | boolean>;
  onInputChange: React.ChangeEventHandler<HTMLTextAreaElement>;
  createConversationBeforeUploadDocument?(message: string): Promise<any>;
  stopOutputMessage?(): void;
  onUpload?: NonNullable<FileUploadProps['onUpload']>;
  removeFile?(file: File): void;
  showReasoning?: boolean;
  showInternet?: boolean;
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
  leadingActions?: React.ReactNode;
  trailingActions?: React.ReactNode;
  mediaCommands?: boolean;
}

const MediaCommands = [
  { command: '@语音', icon: Volume2 },
  { command: '@生图', icon: ImagePlus },
];

export function NextMessageInput({
  isUploading = false,
  value,
  sendDisabled,
  sendLoading,
  disabled,
  showUploadIcon = true,
  resize = 'none',
  onUpload,
  onInputChange,
  stopOutputMessage,
  onPressEnter,
  removeFile,
  showReasoning = false,
  showInternet = false,
  leadingActions,
  trailingActions,
  mediaCommands = false,
  conversationId,
}: NextMessageInputProps) {
  const { t } = useTranslation();
  const [files, setFiles] = React.useState<File[]>([]);
  const [unreadyFiles, setUnreadyFiles] = useState(new Set<File>());
  const attachmentGeneration = useRef(0);
  const uploadOptions = useRef(
    new Map<File, Parameters<NonNullable<FileUploadProps['onUpload']>>[1]>(),
  );
  const [failedFiles, setFailedFiles] = useState(new Set<File>());
  const submitting = useRef(false);

  useEffect(() => {
    attachmentGeneration.current++;
    setFiles([]);
    setUnreadyFiles(new Set());
    setFailedFiles(new Set());
    uploadOptions.current.clear();
  }, [conversationId]);

  const handleAcceptFiles = useCallback((accepted: File[]) => {
    setUnreadyFiles((previous) => new Set([...previous, ...accepted]));
  }, []);

  const handleUpload: NonNullable<FileUploadProps['onUpload']> = useCallback(
    async (uploads, options) => {
      const generation = attachmentGeneration.current;
      uploads.forEach((file) => uploadOptions.current.set(file, options));
      setFailedFiles(
        (previous) =>
          new Set([...previous].filter((file) => !uploads.includes(file))),
      );
      uploads.forEach((file) => options.onProgress(file, 0));
      const onSuccess = (file: File) => {
        options.onSuccess(file);
        if (generation !== attachmentGeneration.current) return;
        setUnreadyFiles((previous) => {
          const next = new Set(previous);
          next.delete(file);
          return next;
        });
      };
      const onError = (file: File, error: Error) => {
        options.onError(file, error);
        if (generation !== attachmentGeneration.current) return;
        setFailedFiles((previous) => new Set([...previous, file]));
      };
      if (onUpload) {
        try {
          await onUpload(uploads, { ...options, onSuccess, onError });
        } catch (error) {
          uploads.forEach((file) =>
            onError(
              file,
              error instanceof Error
                ? error
                : new Error(t('chat.attachmentUploadFailed')),
            ),
          );
        }
      } else {
        uploads.forEach(onSuccess);
      }
    },
    [onUpload, t],
  );
  const handleRetryFile = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const file = files[Number(event.currentTarget.dataset.fileIndex)];
      const options = uploadOptions.current.get(file);
      if (file && options) void handleUpload([file], options);
    },
    [files, handleUpload],
  );
  const hasUnreadyFiles = files.some((file) => unreadyFiles.has(file));
  const cannotSend =
    disabled ||
    sendDisabled ||
    isUploading ||
    sendLoading ||
    hasUnreadyFiles ||
    (!value.trim() && files.length === 0);

  const enableThinking = useThinkingLevel();
  const [enableInternet, setEnableInternet] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandListId = React.useId();
  const [commandIndex, setCommandIndex] = useState(0);
  const [dismissedCommand, setDismissedCommand] = useState<string>();
  const commandQuery = value.trimStart();
  const commands =
    mediaCommands && /^@[^\s：:]*$/.test(commandQuery)
      ? MediaCommands.filter(({ command }) =>
          command.toLowerCase().startsWith(commandQuery.toLowerCase()),
        )
      : [];
  const showCommands =
    commands.length > 0 &&
    dismissedCommand !== value &&
    !disabled &&
    !sendLoading;
  const activeCommandIndex = Math.min(
    commandIndex,
    Math.max(0, commands.length - 1),
  );

  const chooseCommand = useCallback(
    (command: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const nextValue = `${command} `;
      onInputChange({
        target: { ...textarea, value: nextValue },
        currentTarget: { ...textarea, value: nextValue },
      } as React.ChangeEvent<HTMLTextAreaElement>);
      setCommandIndex(0);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(nextValue.length, nextValue.length);
      });
    },
    [onInputChange],
  );

  const handleCommandClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const command = event.currentTarget.dataset.command;
      if (command) chooseCommand(command);
    },
    [chooseCommand],
  );

  const handleCommandMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
  }, []);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setCommandIndex(0);
      setDismissedCommand(undefined);
      onInputChange(event);
    },
    [onInputChange],
  );

  const handleBlur = useCallback(() => setDismissedCommand(value), [value]);
  const handleFocus = useCallback(() => setDismissedCommand(undefined), []);
  const [isManualMode, setIsManualMode] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartRef = useRef({ startY: 0, startHeight: 0 });

  const handleResizeStart = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const textarea = textareaRef.current;
      if (!textarea) return;
      dragStartRef.current = {
        startY: e.clientY,
        startHeight: textarea.getBoundingClientRect().height,
      };
      setIsManualMode(true);
      setIsResizing(true);
    },
    [],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const { startY, startHeight } = dragStartRef.current;
      const delta = startY - e.clientY;
      const newHeight = Math.max(40, Math.min(startHeight + delta, 400));
      textarea.style.height = `${newHeight}px`;
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Level 5 is not a deeper step on the same ladder: the backend hands it to
  // the agentic RAG agent, which runs its own retrieval instead of the
  // pipeline's.
  const thinkingOptions = [
    {
      label: t('chat.thinkingLevelAgentic'),
      value: '5',
      description: t('chat.thinkingLevelAgenticDescription'),
    },
    { label: t('chat.thinkingLevelNone'), value: '0' },
  ];

  const handleThinkingChange = useCallback((value: string) => {
    setThinkingLevel(
      value === ThinkingMode.Agentic
        ? ThinkingMode.Agentic
        : ThinkingMode.Naive,
    );
  }, []);

  const handleInternetToggle = useCallback(() => {
    setEnableInternet((prev) => !prev);
  }, []);

  const pressEnter = useCallback(() => {
    return onPressEnter({
      enableThinking,
      enableInternet: showInternet ? enableInternet : false,
    });
  }, [onPressEnter, enableThinking, enableInternet, showInternet]);

  const onFileReject = React.useCallback((file: File, message: string) => {
    toast(message, {
      description: `"${file.name.length > 20 ? `${file.name.slice(0, 20)}...` : file.name}" has been rejected`,
    });
  }, []);

  const submit = React.useCallback(async () => {
    if (cannotSend || submitting.current) return;
    submitting.current = true;
    const generation = attachmentGeneration.current;
    try {
      const accepted = await pressEnter();
      if (accepted === false || generation !== attachmentGeneration.current)
        return;
      setFiles([]);
      setUnreadyFiles(new Set());
      setFailedFiles(new Set());
      uploadOptions.current.clear();
    } catch {
      toast.error(t('message.requestError'));
    } finally {
      submitting.current = false;
    }
  }, [cannotSend, pressEnter, t]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (showCommands) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedCommand(value);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCommandIndex(
          (activeCommandIndex +
            (e.key === 'ArrowDown' ? 1 : -1) +
            commands.length) %
            commands.length,
        );
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        chooseCommand(commands[activeCommandIndex].command);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onSubmit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    },
    [submit],
  );

  const handleRemoveFile = React.useCallback(
    (file: File) => () => {
      removeFile?.(file);
    },
    [removeFile],
  );

  return (
    <FileUpload
      value={files}
      onValueChange={setFiles}
      onUpload={handleUpload}
      onAccept={handleAcceptFiles}
      onFileReject={onFileReject}
      className="relative w-full items-center"
      disabled={disabled || sendLoading}
      multiple
    >
      <FileUploadDropzone
        asChild
        openOnClick={false}
        openOnKeyDown={false}
        aria-disabled={disabled}
        data-disabled={disabled ? '' : undefined}
        tabIndex={-1}
        className="group/upload select-text items-stretch justify-start rounded-md border-0 p-0 hover:bg-bg-card data-[dragging]:bg-bg-card"
      >
        <form
          onSubmit={onSubmit}
          className="
          relative flex w-full flex-col gap-2.5 rounded-md
          border-0.5 border-border-default bg-bg-card p-2 outline-none
          has-[textarea:focus]:outline-accent-primary has-[textarea:focus]:outline-1 has-[textarea:focus]:outline-offset-2
        "
        >
          <div className="pointer-events-none absolute inset-0 z-30 hidden items-center justify-center gap-2 rounded-md border border-accent-primary bg-bg-base/95 text-text-primary group-data-[dragging]/upload:flex">
            <Upload className="size-5" />
            <span>{t('chat.dropAttachments')}</span>
          </div>
          {showCommands && (
            <div
              id={commandListId}
              role="listbox"
              aria-label={t('chat.mediaCommands', { defaultValue: '模型工具' })}
              className="absolute bottom-full left-0 z-20 mb-2 w-64 max-w-full rounded-md border border-border-default bg-bg-base p-1 shadow-lg"
            >
              {commands.map(({ command, icon: Icon }, index) => (
                <Button
                  key={command}
                  id={`${commandListId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={activeCommandIndex === index}
                  variant="ghost"
                  data-command={command}
                  onMouseDown={handleCommandMouseDown}
                  onClick={handleCommandClick}
                  className={`h-10 w-full justify-start gap-2 ${activeCommandIndex === index ? 'bg-bg-card' : ''}`}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{command}</span>
                </Button>
              ))}
            </div>
          )}
          {resize === 'vertical' && (
            <button
              type="button"
              onMouseDown={handleResizeStart}
              aria-label="Drag to resize height"
              className="absolute -top-0.5 left-1/2 z-10 flex h-1 w-12 -translate-x-1/2 cursor-ns-resize items-center justify-center rounded-full border border-border-default bg-bg-card transition-colors hover:border-accent-primary"
            >
              <span className="h-0.5 w-full rounded-full bg-border-button" />
            </button>
          )}
          <FileUploadList
            orientation="horizontal"
            className="overflow-x-auto px-0 py-1"
          >
            {files.map((file, index) => (
              <FileUploadItem
                key={index}
                value={file}
                className="max-w-52 p-1.5"
              >
                <FileUploadItemPreview className="size-8 [&>svg]:size-5">
                  <FileUploadItemProgress variant="fill" />
                </FileUploadItemPreview>
                <FileUploadItemMetadata size="sm" />
                {failedFiles.has(file) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    title={t('chat.retryAttachment')}
                    aria-label={t('chat.retryAttachment')}
                    data-file-index={index}
                    onClick={handleRetryFile}
                    disabled={isUploading}
                  >
                    <RotateCw className="size-3.5" />
                  </Button>
                )}
                <FileUploadItemDelete asChild>
                  <Button
                    variant="secondary"
                    size="icon"
                    className="-top-1 -right-1 absolute size-4 shrink-0 cursor-pointer rounded-full"
                    onClick={handleRemoveFile(file)}
                    aria-label={`${t('common.delete')} ${file.name}`}
                  >
                    <X className="size-2.5" />
                  </Button>
                </FileUploadItemDelete>
              </FileUploadItem>
            ))}
          </FileUploadList>
          <Textarea
            ref={textareaRef}
            data-testid="chat-textarea"
            value={value}
            onChange={handleChange}
            onBlur={handleBlur}
            onFocus={handleFocus}
            aria-autocomplete={mediaCommands ? 'list' : undefined}
            aria-controls={showCommands ? commandListId : undefined}
            aria-activedescendant={
              showCommands
                ? `${commandListId}-${activeCommandIndex}`
                : undefined
            }
            placeholder={t('chat.messagePlaceholder')}
            className="
            min-h-10 max-h-[400px] w-full p-0 overflow-auto
            !outline-none !border-transparent !bg-transparent !shadow-none !ring-transparent !ring-offset-transparent
          "
            disabled={disabled || sendLoading}
            onKeyDown={handleKeyDown}
            resize={resize === 'vertical' ? 'none' : resize}
            autoSize={isManualMode ? undefined : { minRows: 2, maxRows: 8 }}
          />

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {showUploadIcon && (
                <FileUploadTrigger asChild>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="transparent"
                    className="rounded-sm border-0"
                    disabled={isUploading || sendLoading}
                    data-testid="chat-detail-attach"
                  >
                    <Paperclip className="size-3.5" />
                    <span className="sr-only">{t('chat.attachFiles')}</span>
                  </Button>
                </FileUploadTrigger>
              )}

              {leadingActions}

              {showReasoning && (
                <SelectWithSearch
                  value={enableThinking}
                  options={thinkingOptions}
                  onChange={handleThinkingChange}
                  triggerClassName="h-7 w-auto max-w-44 min-w-0 border-0 !bg-bg-card text-sm"
                  testId="chat-detail-thinking-toggle"
                />
              )}

              {showInternet && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={enableInternet ? 'accent' : 'transparent'}
                      size="icon-xs"
                      className="border-0"
                      onClick={handleInternetToggle}
                      data-testid="chat-detail-internet-toggle"
                    >
                      <Globe />
                      <span className="sr-only">{t('chat.webSearch')}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('chat.webSearch')}</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            <div className="ml-auto flex min-w-0 items-center gap-2">
              {trailingActions}
              {sendLoading ? (
                <Button
                  data-testid="chat-stream-status"
                  onClick={stopOutputMessage}
                  size="icon-xs"
                >
                  <CircleStop />
                </Button>
              ) : (
                <Button
                  size="icon-xs"
                  disabled={cannotSend}
                  data-testid="chat-detail-send"
                >
                  <Send />
                  <span className="sr-only">Send message</span>
                </Button>
              )}
            </div>
          </div>
        </form>
      </FileUploadDropzone>
    </FileUpload>
  );
}
