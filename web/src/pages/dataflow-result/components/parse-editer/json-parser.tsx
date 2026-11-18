import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { useCallback, useEffect, useRef, type FocusEvent } from 'react';
import { ChunkTextMode } from '../../constant';
import styles from '../../index.module.less';
import { IChunk } from '../../interface';
import { useParserInit } from './hook';
import { IJsonContainerProps } from './interface';
export const ArrayContainer = (props: IJsonContainerProps) => {
  const {
    initialValue: content,
    isChunck,
    handleCheck,
    selectedChunkIds,
    onSave,
    className,
    textMode,
    clickChunk,
    isReadonly,
    newChunkIndex,
  } = props;

  const { activeEditIndex, setActiveEditIndex, editDivRef } = useParserInit();

  const sectionRefs = useRef<(HTMLElement | null)[]>([]);

  const parserKey = content.fieldName;

  const handleSave = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const text = e.currentTarget.textContent ?? '';
      onSave({
        ...content,
        value: content.value.map((item, index) =>
          index === activeEditIndex ? { ...item, [parserKey]: text } : item,
        ),
      });
      setActiveEditIndex(undefined);
    },
    [content, onSave, activeEditIndex, parserKey, setActiveEditIndex],
  );

  useEffect(() => {
    if (activeEditIndex !== undefined && editDivRef.current) {
      editDivRef.current.focus();
      const value = content.value[activeEditIndex]?.[parserKey];
      editDivRef.current.textContent = typeof value === 'string' ? value : '';
    }
  }, [editDivRef, activeEditIndex, content, parserKey]);

  useEffect(() => {
    if (newChunkIndex === undefined) return;
    const target = sectionRefs.current[newChunkIndex];
    if (!target) return;

    // Scroll only the nearest scrollable ancestor so the whole page doesn't shift
    let scrollContainer: HTMLElement | null = target.parentElement;
    while (scrollContainer) {
      const { overflowY } = window.getComputedStyle(scrollContainer);
      if (overflowY === 'auto' || overflowY === 'scroll') break;
      scrollContainer = scrollContainer.parentElement;
    }

    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const offsetTop =
        targetRect.top - containerRect.top + scrollContainer.scrollTop;
      const targetCenter = offsetTop + target.clientHeight / 2;
      scrollContainer.scrollTo({
        top: Math.max(0, targetCenter - scrollContainer.clientHeight / 2),
        behavior: 'smooth',
      });
    }
  }, [newChunkIndex, content]);

  return (
    <>
      {content.value.map((item, index) => {
        const text = item[parserKey];
        if (item.text === '' || typeof text !== 'string' || !text) {
          return null;
        }
        return (
          <section
            key={index}
            ref={(el) => {
              sectionRefs.current[index] = el;
            }}
            className={cn(
              isChunck
                ? 'bg-bg-card my-2 p-2 rounded-lg flex gap-1 items-start transition-shadow duration-300'
                : '',
              activeEditIndex === index && isChunck ? 'bg-bg-title' : '',
              newChunkIndex === index && isChunck
                ? 'ring-2 ring-accent-primary'
                : '',
            )}
          >
            {isChunck && !isReadonly && (
              <Checkbox
                onCheckedChange={(e) => {
                  handleCheck(e, index);
                }}
                checked={selectedChunkIds?.some(
                  (id) => id.toString() === index.toString(),
                )}
              ></Checkbox>
            )}
            {activeEditIndex === index && (
              <div
                ref={editDivRef}
                contentEditable={!isReadonly}
                onBlur={handleSave}
                className={cn(
                  'w-full bg-transparent text-text-secondary border-none focus-visible:border-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none p-0',

                  className,
                )}
              ></div>
            )}
            {activeEditIndex !== index && (
              <div
                className={cn(
                  'text-text-secondary overflow-auto scrollbar-auto w-full min-h-3',
                  {
                    [styles.contentEllipsis]:
                      textMode === ChunkTextMode.Ellipse,
                  },
                )}
                key={index}
                onClick={() => {
                  clickChunk(item as unknown as IChunk);
                  if (!isReadonly) {
                    setActiveEditIndex(index);
                  }
                }}
              >
                {text}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
};
