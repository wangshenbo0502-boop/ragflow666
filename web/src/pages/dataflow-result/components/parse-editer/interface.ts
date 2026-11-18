import { CheckedState } from '@radix-ui/react-checkbox';
import { ChunkTextMode } from '../../constant';
import { IChunk } from '../../interface';

type ParserArrayValue = {
  key: 'json' | 'chunks';
  value: Record<string, unknown>[];
  fieldName: string;
};

type ParserTextValue = {
  key: 'text' | 'html' | 'markdown';
  value: string;
};

export type ParserEditorValue = ParserArrayValue | ParserTextValue;

export interface FormatPreserveEditorProps {
  initialValue: ParserEditorValue;
  onSave: (value: ParserEditorValue) => void;
  className?: string;
  isChunck?: boolean;
  handleCheckboxClick?: (id: string | number, checked: boolean) => void;
  selectedChunkIds?: string[];
  textMode?: ChunkTextMode;
  clickChunk: (chunk: IChunk) => void;
  isReadonly: boolean;
  newChunkIndex?: number;
}

type ContainerProps = Omit<
  FormatPreserveEditorProps,
  'initialValue' | 'handleCheckboxClick'
>;

export type IJsonContainerProps = ContainerProps & {
  initialValue: ParserArrayValue;
  handleCheck: (e: CheckedState, index: number) => void;
};

export type IObjContainerProps = ContainerProps & {
  initialValue: ParserTextValue;
};
