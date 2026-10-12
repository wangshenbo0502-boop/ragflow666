import { buildRailwayQuestion, EmptyEquipmentContext } from './railway-question';

test('keeps equipment context out of other railway scenes', () => {
  expect(
    buildRailwayQuestion('passenger', '  实名制要求？ ', {
      ...EmptyEquipmentContext,
      model: '测试设备',
    }),
  ).toBe('实名制要求？');
});

test('preserves observed equipment facts without inventing missing information', () => {
  const question = buildRailwayQuestion('equipment', '指示灯闪烁', {
    model: ' 测试型号 ',
    alarm: 'E01',
    location: '',
    occurredAt: '2026-10-12T09:30',
  });
  expect(question).toContain('设备型号：测试型号');
  expect(question).toContain('报警代码或提示：E01');
  expect(question).toContain('发生时间（用户当地时间）：2026-10-12 09:30');
  expect(question).not.toContain('发生位置');
  expect(question).toContain('原因尚未确认');
});

test('allows ordinary equipment questions without an incident record', () => {
  expect(
    buildRailwayQuestion('equipment', '  设备质量如何追溯？ ', EmptyEquipmentContext),
  ).toBe('设备质量如何追溯？');
});
