import { useRef, useState } from 'react';

export const useParserInit = () => {
  const [activeEditIndex, setActiveEditIndex] = useState<number | undefined>(
    undefined,
  );
  const editDivRef = useRef<HTMLDivElement>(null);

  return {
    activeEditIndex,
    setActiveEditIndex,
    editDivRef,
  };
};
