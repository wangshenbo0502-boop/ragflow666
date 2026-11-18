import { getParserEditorValue } from './editor-value';

function parserParams(key: string, value: unknown, field_name = '') {
  return {
    field_name,
    outputs: { output_format: { value: key }, [key]: { value } },
  };
}

test.each(['text', 'html', 'markdown'])('keeps %s output as text', (key) => {
  expect(getParserEditorValue(parserParams(key, 'line 1\nline 2'))).toEqual({
    key,
    value: 'line 1\nline 2',
  });
});

test('keeps list metadata and uses the configured chunk field', () => {
  const chunks = [{ body: 'chunk body', positions: [[1, 0, 1, 0, 1]] }];
  expect(getParserEditorValue(parserParams('chunks', chunks, 'body'))).toEqual({
    key: 'chunks',
    fieldName: 'body',
    value: chunks,
  });
  expect(getParserEditorValue(parserParams('json', []))).toEqual({
    key: 'json',
    fieldName: 'text',
    value: [],
  });
});

test('does not open an editor for missing or malformed output', () => {
  expect(getParserEditorValue()).toBeUndefined();
  expect(getParserEditorValue(parserParams('json', '{}'))).toBeUndefined();
  expect(getParserEditorValue(parserParams('chunks', [null]))).toBeUndefined();
  expect(getParserEditorValue(parserParams('text', []))).toBeUndefined();
  expect(getParserEditorValue(parserParams('unknown', 'text'))).toBeUndefined();
});
