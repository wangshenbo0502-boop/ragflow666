import { FileUploadProps } from '@/components/file-upload';
import {
  useGetChatSearchParams,
  useUploadAndParseFile,
} from '@/hooks/use-chat-request';
import { UploadResponseDataType } from '@/interfaces/database/chat';
import { useCallback, useEffect, useRef, useState } from 'react';

function getFilesInSelectionOrder(
  fileMap: Map<File, UploadResponseDataType>,
  fileOrder: Map<File, number>,
) {
  return [...fileMap.entries()]
    .sort(([left], [right]) => fileOrder.get(left)! - fileOrder.get(right)!)
    .map(([, uploaded]) => uploaded);
}

export function useUploadFile() {
  const { uploadAndParseFile, cancel } = useUploadAndParseFile();
  const [currentFiles, setCurrentFiles] = useState<UploadResponseDataType[]>(
    [],
  );
  const fileMap = useRef(new Map<File, UploadResponseDataType>());
  const fileOrder = useRef(new Map<File, number>());
  const nextFileOrder = useRef(0);
  const removedFiles = useRef(new WeakSet<File>());
  const generation = useRef(0);
  const queue = useRef(Promise.resolve());
  const [pendingBatches, setPendingBatches] = useState(0);
  const { conversationId } = useGetChatSearchParams();

  const clearFiles = useCallback(() => {
    generation.current++;
    fileMap.current.clear();
    fileOrder.current.clear();
    nextFileOrder.current = 0;
    queue.current = Promise.resolve();
    setPendingBatches(0);
    setCurrentFiles([]);
  }, []);

  useEffect(() => {
    const generationRef = generation;
    clearFiles();
    return () => {
      generationRef.current++;
      cancel();
    };
  }, [conversationId, clearFiles, cancel]);

  type FileUploadParameters = Parameters<
    NonNullable<FileUploadProps['onUpload']>
  >;

  const handleUploadFile = useCallback(
    async (
      files: FileUploadParameters[0],
      options: FileUploadParameters[1],
    ) => {
      const batchGeneration = generation.current;
      for (const file of files) {
        if (!fileOrder.current.has(file)) {
          fileOrder.current.set(file, nextFileOrder.current++);
        }
      }
      setPendingBatches((count) => count + 1);
      const batch = queue.current.then(async () => {
        for (const file of files) {
          if (
            batchGeneration !== generation.current ||
            removedFiles.current.has(file)
          )
            continue;
          const ret = await uploadAndParseFile({
            file,
            options,
            conversationId,
          });
          if (
            ret?.code === 0 &&
            batchGeneration === generation.current &&
            !removedFiles.current.has(file)
          ) {
            const data = ret.data;
            fileMap.current.set(file, data);
            setCurrentFiles(
              getFilesInSelectionOrder(fileMap.current, fileOrder.current),
            );
          }
        }
      });
      queue.current = batch.catch(() => {});
      try {
        await batch;
      } finally {
        if (batchGeneration === generation.current) {
          setPendingBatches((count) => count - 1);
        }
      }
    },
    [uploadAndParseFile, conversationId],
  );

  const removeFile = useCallback((file: File) => {
    removedFiles.current.add(file);
    fileMap.current.delete(file);
    fileOrder.current.delete(file);
    setCurrentFiles(
      getFilesInSelectionOrder(fileMap.current, fileOrder.current),
    );
  }, []);

  return {
    handleUploadFile,
    files: currentFiles,
    isUploading: pendingBatches > 0,
    removeFile,
    clearFiles: clearFiles,
  };
}
