import { isPlainObject } from 'lodash';
import type { ComponentParams } from '../../interface';
import type { ParserEditorValue } from './interface';

function isParserRow(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

export function getParserEditorValue(
  params?: Pick<ComponentParams, 'outputs' | 'field_name'>,
): ParserEditorValue | undefined {
  const outputs = params?.outputs;
  const key = outputs?.output_format?.value;

  if (key === 'json' || key === 'chunks') {
    const value = outputs?.[key]?.value;
    if (Array.isArray(value) && value.every(isParserRow)) {
      return {
        key,
        value,
        fieldName: (key === 'chunks' && params?.field_name) || 'text',
      };
    }
  }

  if (key === 'text' || key === 'html' || key === 'markdown') {
    const value = outputs?.[key]?.value;
    if (typeof value === 'string') {
      return { key, value };
    }
  }
}
