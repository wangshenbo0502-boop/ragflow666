import { cn } from '@/lib/utils';
import { useCallback, useEffect, type FocusEvent } from 'react';
import { ChunkTextMode } from '../../constant';
import styles from '../../index.module.less';
import { useParserInit } from './hook';
import { IObjContainerProps } from './interface';
export const ObjectContainer = (props: IObjContainerProps) => {
  const {
    initialValue: content,
    isChunck,
    onSave,
    className,
    textMode,
    clickChunk,
    isReadonly,
  } = props;

  const { activeEditIndex, setActiveEditIndex, editDivRef } = useParserInit();

  const handleEdit = useCallback(() => {
    setActiveEditIndex(1);
  }, [setActiveEditIndex]);

  const handleSave = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const saveData = {
        ...content,
        value: e.currentTarget.textContent ?? '',
      };
      onSave(saveData);
      setActiveEditIndex(undefined);
    },
    [content, onSave, setActiveEditIndex],
  );

  useEffect(() => {
    if (activeEditIndex !== undefined && editDivRef.current) {
      editDivRef.current.focus();
      editDivRef.current.textContent = content.value;
      editDivRef.current.style.whiteSpace = 'pre-wrap';
    }
  }, [activeEditIndex, content, editDivRef]);

  return (
    <>
      <section
        className={
          isChunck
            ? 'bg-bg-card my-2 p-2 rounded-lg flex gap-1 items-start'
            : ''
        }
      >
        {activeEditIndex && (
          <div
            ref={editDivRef}
            contentEditable={!isReadonly}
            onBlur={handleSave}
            className={cn(
              'w-full bg-transparent text-text-secondary border-none focus-visible:border-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none p-0',
              className,
            )}
          />
        )}
        {!activeEditIndex && (
          <div
            className={cn(
              'text-text-secondary overflow-auto scrollbar-auto whitespace-pre-wrap w-full',
              {
                [styles.contentEllipsis]: textMode === ChunkTextMode.Ellipse,
              },
            )}
            onClick={() => {
              clickChunk({ text: content.value, positions: [] });
              if (!isReadonly) {
                handleEdit();
              }
            }}
          >
            {content.value}
          </div>
        )}
      </section>
    </>
  );
};
